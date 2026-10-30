import {
  type CallExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  definition,
  isFunctionLike,
  literalText,
  methodName,
  type ModuleIndex,
  moduleOf,
  objectLiteral,
  propertyValue,
  receiverOf,
  unwrap,
} from "./fastify-plugins.js";
import { AUTH_NAMES, throwsAuthError } from "./trpc-syntax.js";

/**
 * Authentication in front of every tRPC procedure rather than in their
 * middleware: a createContext that rejects anonymous callers, auth
 * middleware ahead of the Express mount that serves the router, or a
 * Next.js middleware (`proxy` in Next.js 16) that rejects unauthenticated
 * requests to the tRPC endpoint. Each is reported by where it was found.
 */

type Sources = ReadonlyArray<{ file: string; sourceFile: SourceFile }>;

const ADAPTER_MODULE = /^@trpc\/server\/adapters\/|^@hono\/trpc-server$/;
/** A value naming the caller: `session`, `token`, `req.auth`, `user`. */
const IDENTITY = /(?:session|token|auth|user|userId|identity|viewer|jwt)\b/i;
/** A response that turns an anonymous request away. */
const REJECTION =
  /\bredirect\s*\(|\brewrite\s*\(|status\s*:\s*40[13]\b|\b40[13]\b/;
const NEXT_AUTH_MIDDLEWARE = "next-auth/middleware";
const MIDDLEWARE_FILES = ["middleware", "src/middleware", "proxy", "src/proxy"];
const MIDDLEWARE_EXTENSIONS = [".ts", ".js", ".mjs"];
/** Stands in for a procedure path in a dynamic route segment; it has a dot, as real ones do. */
const SAMPLE_PROCEDURE = "post.create";
/** Bounds the functions followed from createContext into the project. */
const MAX_CONTEXT_DEPTH = 2;

/** The function a node holds, through variables and imports. */
function functionValue(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): Node | undefined {
  if (!node || depth > MAX_CONTEXT_DEPTH + 2) return undefined;
  const value = definition(index, node);
  if (isFunctionLike(value)) return value;
  if (Node.isVariableDeclaration(value)) {
    return functionValue(index, value.getInitializer(), depth + 1);
  }
  return undefined;
}

/** `if (!session) throw ...` or `if (!token) return redirect(...)`. */
function guardsAnonymous(
  fn: Node,
  rejects: (branch: Node) => boolean,
): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.IfStatement).some((statement) => {
    const condition = unwrap(statement.getExpression());
    return (
      Node.isPrefixUnaryExpression(condition) &&
      condition.getOperatorToken() === SyntaxKind.ExclamationToken &&
      IDENTITY.test(condition.getOperand().getText()) &&
      rejects(statement.getThenStatement())
    );
  });
}

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

/** Calls to tRPC adapters and the options object each receives. */
function adapterCalls(
  index: ModuleIndex,
  sources: Sources,
): Array<{ call: CallExpression; file: string; options: Node | undefined }> {
  const calls: Array<{
    call: CallExpression;
    file: string;
    options: Node | undefined;
  }> = [];
  for (const { file, sourceFile } of sources) {
    if (
      !/@trpc\/server\/adapters\/|@hono\/trpc-server/.test(
        sourceFile.getFullText(),
      )
    ) {
      continue;
    }
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const [first, second] = call.getArguments();
      if (ADAPTER_MODULE.test(moduleOf(call.getExpression()) ?? "")) {
        calls.push({ call, file, options: first });
      } else if (
        // fastify.register(fastifyTRPCPlugin, { trpcOptions: { createContext } })
        methodName(call) === "register" &&
        first &&
        ADAPTER_MODULE.test(moduleOf(first) ?? "")
      ) {
        const options = objectLiteral(index, second);
        calls.push({
          call,
          file,
          options: propertyValue(options?.getProperty("trpcOptions")),
        });
      }
    }
  }
  return calls;
}

function rejectingContext(
  index: ModuleIndex,
  adapters: ReturnType<typeof adapterCalls>,
): string | null {
  const contexts = adapters.flatMap(({ options }) => {
    const value = propertyValue(
      objectLiteral(index, options)?.getProperty("createContext"),
    );
    const fn = functionValue(index, value);
    return fn ? [fn] : [];
  });
  // Every adapter must reject: one open handler serves the whole router.
  const rejecting = contexts.map((fn) => rejectingFunction(index, fn));
  const [first] = rejecting;
  if (!first || rejecting.some((fn) => fn === undefined)) return null;
  // Name the function that rejects, not an inline arrow that calls it.
  return `createContext in ${index.paths.get(first.getSourceFile())} rejects anonymous callers`;
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

function expressMountAuth(
  adapters: ReturnType<typeof adapterCalls>,
): string | null {
  const mounted = adapters.flatMap(({ call, file }) =>
    mounts(call).map((use) => ({ use, file })),
  );
  if (mounted.length === 0) return null;
  const guarded = mounted.map(({ use, file }) => ({
    file,
    middleware: mountAuth(use),
  }));
  if (!guarded.every(({ middleware }) => middleware !== null)) return null;
  const [first] = guarded;
  return first
    ? `${first.middleware} runs before the tRPC mount in ${first.file}`
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

/**
 * Whether a Next.js matcher (path-to-regexp syntax with regex groups)
 * matches a path. Only the fixed sample path is tested, so a pattern from the
 * project cannot make matching slow.
 */
function matches(pattern: string, path: string): boolean {
  const source = pattern
    .replace(/\/:\w+\*/g, "(?:/.*)?")
    .replace(/\/:\w+\+/g, "/.+")
    .replace(/\/:\w+\?/g, "(?:/[^/]+)?")
    .replace(/:\w+/g, "[^/]+");
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

/** String patterns in a literal, an array, or `{ source }` objects; null when not literal. */
function literalPatterns(
  index: ModuleIndex,
  node: Node | undefined,
): string[] | null {
  if (!node) return null;
  const value = unwrap(node);
  const single = literalText(value);
  if (single !== null) return [single];
  if (!Node.isArrayLiteralExpression(value)) return null;
  const patterns: string[] = [];
  for (const element of value.getElements()) {
    const text =
      literalText(element) ??
      literalText(
        propertyValue(objectLiteral(index, element)?.getProperty("source")),
      );
    if (text === null) return null;
    patterns.push(text);
  }
  return patterns;
}

/** Whether the middleware runs for a path: no matcher means every path. */
function runsFor(
  index: ModuleIndex,
  sourceFile: SourceFile,
  path: string,
): boolean {
  const config = sourceFile.getVariableDeclaration("config");
  if (!config?.isExported()) return true;
  const matcher = objectLiteral(index, config.getInitializer())?.getProperty(
    "matcher",
  );
  if (!matcher) return true;
  const patterns = literalPatterns(index, propertyValue(matcher));
  return patterns?.some((pattern) => matches(pattern, path)) ?? false;
}

/**
 * Clerk's `auth.protect()`: unconditional, or under `isProtected(req)` /
 * `!isPublic(req)` whose createRouteMatcher patterns decide the path.
 */
function protectsPath(
  index: ModuleIndex,
  sourceFile: SourceFile,
  path: string,
): boolean {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => methodName(call) === "protect")
    .some((call) => {
      const guard = call.getFirstAncestorByKind(SyntaxKind.IfStatement);
      if (!guard) return true;
      let condition = unwrap(guard.getExpression());
      let negated = false;
      if (
        Node.isPrefixUnaryExpression(condition) &&
        condition.getOperatorToken() === SyntaxKind.ExclamationToken
      ) {
        negated = true;
        condition = unwrap(condition.getOperand());
      }
      if (!Node.isCallExpression(condition)) return false;
      const matcher = definition(index, condition.getExpression());
      const created = Node.isVariableDeclaration(matcher)
        ? matcher.getInitializer()
        : undefined;
      if (!Node.isCallExpression(created)) return false;
      const patterns = literalPatterns(index, created.getArguments()[0]);
      if (patterns === null) return false;
      const covered = patterns.some((pattern) => matches(pattern, path));
      return negated ? !covered : covered;
    });
}

/** True when a middleware turns anonymous requests to the path away. */
function middlewareRejects(
  index: ModuleIndex,
  sourceFile: SourceFile,
  path: string,
): boolean {
  // next-auth v4's middleware redirects every request without a token.
  const nextAuth = [
    ...sourceFile.getExportDeclarations(),
    ...sourceFile.getImportDeclarations(),
  ].some(
    (declaration) =>
      declaration.getModuleSpecifierValue() === NEXT_AUTH_MIDDLEWARE,
  );
  return (
    nextAuth ||
    protectsPath(index, sourceFile, path) ||
    guardsAnonymous(sourceFile, (branch) => REJECTION.test(branch.getText()))
  );
}

function nextMiddlewareAuth(
  index: ModuleIndex,
  adapters: ReturnType<typeof adapterCalls>,
): string | null {
  const paths = [
    ...new Set(adapters.flatMap(({ file }) => routePath(file) ?? [])),
  ];
  if (paths.length === 0) return null;
  const file = MIDDLEWARE_FILES.flatMap((name) =>
    MIDDLEWARE_EXTENSIONS.map((extension) => `${name}${extension}`),
  ).find((candidate) => index.files.has(candidate));
  const sourceFile = file ? index.files.get(file) : undefined;
  if (!file || !sourceFile) return null;
  const covered = paths.every(
    (path) =>
      runsFor(index, sourceFile, path) &&
      middlewareRejects(index, sourceFile, path),
  );
  if (!covered) return null;
  const endpoint = (paths[0] ?? "").replace(`/${SAMPLE_PROCEDURE}`, "");
  return `${file} rejects unauthenticated requests to ${endpoint}`;
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
  return (
    rejectingContext(index, adapters) ??
    expressMountAuth(adapters) ??
    nextMiddlewareAuth(index, adapters)
  );
}
