import {
  type CallExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { fastifyTrpcMounts } from "./fastify-api.js";
import {
  importSource,
  literalText,
  methodName,
  type ModuleIndex,
  moduleOf,
  objectLiteral,
  propertyValue,
  receiverOf,
  unwrap,
} from "./fastify-plugins.js";
import { honoTrpcMounts } from "./hono-api.js";
import {
  functionValue,
  guardsAnonymous,
  middlewareFile,
  middlewareRejects,
} from "./next-middleware.js";
import {
  AUTH_NAMES,
  SVELTEKIT_ADAPTER,
  throwsAuthError,
} from "./trpc-syntax.js";

/**
 * Authentication in front of every tRPC procedure rather than in their
 * middleware: a createContext that rejects anonymous callers, auth
 * middleware ahead of the Express or Hono mount that serves the router, an
 * auth hook over the Fastify plugin, or a Next.js middleware (`proxy` in
 * Next.js 16) that rejects unauthenticated requests to the tRPC endpoint.
 * Every adapter that serves the router must be behind one; the first is
 * reported by where it was found.
 */

type Sources = ReadonlyArray<{ file: string; sourceFile: SourceFile }>;

interface Adapter {
  /** The adapter call, or the register() call for the Fastify plugin. */
  call: CallExpression;
  file: string;
  module: string;
  options: Node | undefined;
}

type Perimeter = (adapter: Adapter) => string | null;

const ADAPTER_MODULE = /^@trpc\/server\/adapters\/|^@hono\/trpc-server$/;
const HONO_ADAPTER = "@hono/trpc-server";
const FASTIFY_ADAPTER = "@trpc/server/adapters/fastify";
/** Stands in for a procedure path in a dynamic route segment; it has a dot, as real ones do. */
const SAMPLE_PROCEDURE = "post.create";
/** Bounds the functions followed from createContext into the project. */
const MAX_CONTEXT_DEPTH = 2;

function throws(branch: Node): boolean {
  return (
    Node.isThrowStatement(branch) ||
    branch.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0
  );
}

/** The createContext function, or a project function it calls, that rejects anonymous callers. */
function rejectingFunction(
  index: ModuleIndex,
  fn: Node,
  depth = 0,
): Node | undefined {
  if (throwsAuthError(fn) || guardsAnonymous(fn, throws)) return fn;
  if (depth >= MAX_CONTEXT_DEPTH) return undefined;
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = functionValue(index, call.getExpression());
    const found = callee && rejectingFunction(index, callee, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** `createTRPCHandle({ router, createContext })` from trpc-sveltekit. */
function isSvelteKitAdapter(call: CallExpression): boolean {
  const callee = call.getExpression();
  const declaration = Node.isIdentifier(callee)
    ? callee.getSymbol()?.getDeclarations()[0]
    : undefined;
  const source = declaration ? importSource(declaration) : null;
  return (
    source?.specifier === SVELTEKIT_ADAPTER.specifier &&
    source.name === SVELTEKIT_ADAPTER.name
  );
}

/** Calls to tRPC adapters and the options object each receives. */
function adapterCalls(index: ModuleIndex, sources: Sources): Adapter[] {
  const adapters: Adapter[] = [];
  for (const { file, sourceFile } of sources) {
    if (
      !/@trpc\/server\/adapters\/|@hono\/trpc-server|trpc-sveltekit/.test(
        sourceFile.getFullText(),
      )
    ) {
      continue;
    }
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const [first, second] = call.getArguments();
      const module = moduleOf(call.getExpression()) ?? "";
      const plugin = first ? (moduleOf(first) ?? "") : "";
      if (ADAPTER_MODULE.test(module) || isSvelteKitAdapter(call)) {
        adapters.push({ call, file, module, options: first });
      } else if (
        // fastify.register(fastifyTRPCPlugin, { trpcOptions: { createContext } })
        methodName(call) === "register" &&
        ADAPTER_MODULE.test(plugin)
      ) {
        const options = objectLiteral(index, second);
        adapters.push({
          call,
          file,
          module: plugin,
          options: propertyValue(options?.getProperty("trpcOptions")),
        });
      }
    }
  }
  return adapters;
}

function contextAuth(index: ModuleIndex, adapter: Adapter): string | null {
  const value = propertyValue(
    objectLiteral(index, adapter.options)?.getProperty("createContext"),
  );
  const fn = functionValue(index, value);
  const rejecting = fn && rejectingFunction(index, fn);
  // Name the function that rejects, not an inline arrow that calls it.
  return rejecting
    ? `createContext in ${index.paths.get(rejecting.getSourceFile())} rejects anonymous callers`
    : null;
}

/** The middleware text a mount argument names: `requireAuth`, `passport.authenticate`. */
function middlewareName(node: Node): string {
  const value = unwrap(node);
  return Node.isCallExpression(value)
    ? value.getExpression().getText()
    : value.getText();
}

function isAuthMiddleware(node: Node): boolean {
  return AUTH_NAMES.test(middlewareName(node));
}

/** The `.use()` calls that mount an adapter, directly or through a variable. */
function mounts(call: CallExpression): CallExpression[] {
  const parent = call.getParent();
  if (Node.isCallExpression(parent) && methodName(parent) === "use") {
    return [parent];
  }
  if (!Node.isVariableDeclaration(parent)) return [];
  const name = parent.getName();
  return call
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(
      (use) =>
        methodName(use) === "use" &&
        use.getArguments().some((argument) => argument.getText() === name),
    );
}

/** Auth middleware the request passes before reaching an Express mount. */
function mountAuth(use: CallExpression): string | null {
  const args = use.getArguments();
  const mountPath = literalText(args[0]);
  const handlers = mountPath === null ? args : args.slice(1);
  const own = handlers.slice(0, -1).find(isAuthMiddleware);
  if (own) return middlewareName(own);

  const receiver = receiverOf(use).getText();
  for (const earlier of use
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (earlier.getStart() >= use.getStart()) break;
    if (methodName(earlier) !== "use") continue;
    if (receiverOf(earlier).getText() !== receiver) continue;
    const [first, ...rest] = earlier.getArguments();
    const path = literalText(first);
    // A global use(), or one whose path contains the tRPC mount.
    const applies =
      path === null ||
      (mountPath !== null &&
        (path === "/" ||
          `${mountPath}/`.startsWith(`${path.replace(/\/$/, "")}/`)));
    if (!applies) continue;
    const middleware = (path === null ? earlier.getArguments() : rest).find(
      isAuthMiddleware,
    );
    if (middleware) return middlewareName(middleware);
  }
  return null;
}

function expressMountAuth(adapter: Adapter): string | null {
  // Hono matches use() paths differently; its own analysis decides.
  if (adapter.module === HONO_ADAPTER) return null;
  const guarded = mounts(adapter.call).map(mountAuth);
  const [first] = guarded;
  return first && guarded.every((middleware) => middleware !== null)
    ? `${first} runs before the tRPC mount in ${adapter.file}`
    : null;
}

/** The URL a Next.js route file serves, with a sample procedure for dynamic segments. */
function routePath(file: string): string | null {
  const match = /^(?:src\/)?(app|pages)\/(.+)$/.exec(file);
  if (!match) return null;
  const [, router, rest = ""] = match;
  const segments = rest.split("/");
  const last = segments.pop() ?? "";
  if (router === "app") {
    if (!/^route\.[cm]?[jt]sx?$/.test(last)) return null;
  } else {
    segments.push(last.replace(/\.[cm]?[jt]sx?$/, ""));
  }
  const path = segments
    .filter((segment) => !/^\(.*\)$/.test(segment) && segment !== "index")
    .map((segment) => (/^\[.*\]$/.test(segment) ? SAMPLE_PROCEDURE : segment));
  return `/${path.join("/")}`;
}

function nextMiddlewareAuth(
  index: ModuleIndex,
  adapter: Adapter,
): string | null {
  const path = routePath(adapter.file);
  const middleware = path ? middlewareFile(index) : null;
  if (!path || !middleware) return null;
  if (!middlewareRejects(index, middleware.sourceFile, path)) return null;
  const endpoint = path.replace(`/${SAMPLE_PROCEDURE}`, "");
  return `${middleware.file} rejects unauthenticated requests to ${endpoint}`;
}

/** Ways an adapter can sit behind authentication; framework analyses run once, when needed. */
function perimeters(index: ModuleIndex, sources: Sources): Perimeter[] {
  let hono: ReadonlyMap<Node, boolean> | undefined;
  let fastify: ReadonlyMap<Node, boolean> | undefined;
  return [
    (adapter) => contextAuth(index, adapter),
    expressMountAuth,
    (adapter) => {
      if (adapter.module !== HONO_ADAPTER) return null;
      hono ??= honoTrpcMounts(index, sources);
      return hono.get(adapter.call)
        ? `auth middleware runs before the tRPC mount in ${adapter.file}`
        : null;
    },
    (adapter) => {
      if (adapter.module !== FASTIFY_ADAPTER) return null;
      fastify ??= fastifyTrpcMounts(sources);
      return fastify.get(adapter.call)
        ? `an auth hook runs before the tRPC plugin in ${adapter.file}`
        : null;
    },
    (adapter) => nextMiddlewareAuth(index, adapter),
  ];
}

/**
 * Where every tRPC procedure is authenticated before it runs, or null.
 * Procedures behind such a perimeter need no auth middleware of their own.
 */
export function perimeterAuth(
  index: ModuleIndex,
  sources: Sources,
): string | null {
  const adapters = adapterCalls(index, sources);
  if (adapters.length === 0) return null;
  const checks = perimeters(index, sources);
  // One open adapter serves the whole router, so each must be covered.
  const found: string[] = [];
  for (const adapter of adapters) {
    const perimeter = checks.reduce<string | null>(
      (hit, check) => hit ?? check(adapter),
      null,
    );
    if (perimeter === null) return null;
    found.push(perimeter);
  }
  return found[0] ?? null;
}
