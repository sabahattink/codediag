import { type CallExpression, Node, type SourceFile } from "ts-morph";
import {
  definition,
  exportedValue,
  type FunctionLike,
  isFunctionLike,
  type ModuleIndex,
  resolveImport,
  unwrap,
} from "./fastify-plugins.js";
import {
  type BodyRead,
  bodyRead,
  changesSession,
  checksAuth,
  middlewareAuthenticates,
  returnsOnlyConstants,
  validatesInput,
  wrapperAuthenticates,
} from "./react-router-handlers.js";

/**
 * What a route module exports: its `action` and `loader`, and whether its
 * `middleware` (`unstable_middleware` before React Router 7.9) rejects
 * anonymous requests. `clientAction`, `clientLoader`, and `clientMiddleware`
 * run in the browser and are not read.
 */

const MIDDLEWARE_EXPORTS = ["middleware", "unstable_middleware"];
/** Bounds `export { action } from "./x"` chains and variable aliases. */
const MAX_EXPORT_DEPTH = 4;

export type Kind = "action" | "loader";

export interface Handler {
  /** The export's line in the route module. */
  line: number;
  auth: boolean;
  /** Medium when the request reaches code this scan cannot follow. */
  confidence: "high" | "medium";
  /** Creates or destroys the user's session: sign-in and sign-out. */
  changesSession: boolean;
  body: BodyRead | null;
  validated: boolean;
  /** Returns no request-specific data, such as only a redirect. */
  constant: boolean;
}

export interface RouteModule {
  action: Handler | null;
  loader: Handler | null;
  /** Its middleware rejects anonymous requests. */
  guards: boolean;
}

export const NO_MODULE: RouteModule = {
  action: null,
  loader: null,
  guards: false,
};

/** Assumed protected and valid: an export this scan cannot follow. */
function opaqueHandler(line: number): Handler {
  return {
    line,
    auth: true,
    confidence: "medium",
    changesSession: false,
    body: null,
    validated: true,
    constant: true,
  };
}

/**
 * A module's export, also through `export { action } from "./action.server"`,
 * with the line of the route module that exports it.
 */
function exported(
  index: ModuleIndex,
  sourceFile: SourceFile,
  name: string,
  depth = 0,
): { node: Node; line: number } | null {
  const local = exportedValue(sourceFile, name);
  if (local) return { node: local, line: local.getStartLineNumber() };
  if (depth >= MAX_EXPORT_DEPTH) return null;
  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined || declaration.getNamespaceExport()) continue;
    const named = declaration.getNamedExports();
    const match = named.find(
      (candidate) =>
        (candidate.getAliasNode()?.getText() ?? candidate.getName()) === name,
    );
    if (named.length > 0 && !match) continue;
    const target = resolveImport(index, sourceFile, specifier);
    const found =
      target && exported(index, target, match?.getName() ?? name, depth + 1);
    if (found)
      return { node: found.node, line: declaration.getStartLineNumber() };
  }
  return null;
}

/**
 * The function an export runs, and a wrapper around it such as
 * `withAuth(async (args) => ...)`; null when it cannot be resolved.
 */
function exportedHandler(
  index: ModuleIndex,
  declaration: Node,
): { fn: FunctionLike | null; wrapper: CallExpression | null } | null {
  let value: Node | undefined = declaration;
  for (let depth = 0; value && depth < MAX_EXPORT_DEPTH; depth++) {
    if (Node.isVariableDeclaration(value)) {
      value = value.getInitializer();
      continue;
    }
    if (Node.isImportSpecifier(value)) {
      // import { action } from "./x"; export { action };
      value = definition(index, value.getAliasNode() ?? value.getNameNode());
      continue;
    }
    const unwrapped = unwrap(value);
    if (isFunctionLike(unwrapped)) return { fn: unwrapped, wrapper: null };
    if (Node.isCallExpression(unwrapped)) {
      const inner = unwrapped
        .getArguments()
        .map((argument) => unwrap(argument))
        .find(isFunctionLike);
      return { fn: inner ?? null, wrapper: unwrapped };
    }
    if (!Node.isIdentifier(unwrapped)) return null;
    const resolved = definition(index, unwrapped);
    if (resolved === unwrapped) return null;
    value = resolved;
  }
  return null;
}

function analyzeHandler(
  index: ModuleIndex,
  sourceFile: SourceFile,
  name: Kind,
): Handler | null {
  const declaration = exported(index, sourceFile, name);
  if (!declaration) return null;
  const handler = exportedHandler(index, declaration.node);
  if (!handler) return opaqueHandler(declaration.line);
  const { fn, wrapper } = handler;
  const own = fn ? checksAuth(index, fn) : { auth: false, opaque: true };
  return {
    line: declaration.line,
    auth:
      own.auth || (wrapper !== null && wrapperAuthenticates(index, wrapper)),
    confidence: own.opaque ? "medium" : "high",
    changesSession: fn !== null && changesSession(index, fn),
    body: fn && bodyRead(fn),
    validated: fn !== null && validatesInput(index, fn),
    constant: fn === null || returnsOnlyConstants(fn),
  };
}

/** `export const middleware = [requireUser]`, with an element that rejects anonymous requests. */
function guards(index: ModuleIndex, sourceFile: SourceFile): boolean {
  return MIDDLEWARE_EXPORTS.some((name) => {
    let value: Node | undefined = exported(index, sourceFile, name)?.node;
    for (let depth = 0; value && depth < MAX_EXPORT_DEPTH; depth++) {
      value = Node.isVariableDeclaration(value)
        ? value.getInitializer()
        : unwrap(value);
      if (Node.isIdentifier(value)) value = definition(index, value);
      if (!Node.isArrayLiteralExpression(value)) continue;
      return value
        .getElements()
        .some(
          (element) =>
            !Node.isSpreadElement(element) &&
            middlewareAuthenticates(index, element),
        );
    }
    return false;
  });
}

export function routeModule(index: ModuleIndex, file: string): RouteModule {
  const sourceFile = index.files.get(file);
  if (!sourceFile) return NO_MODULE;
  return {
    action: analyzeHandler(index, sourceFile, "action"),
    loader: analyzeHandler(index, sourceFile, "loader"),
    guards: guards(index, sourceFile),
  };
}
