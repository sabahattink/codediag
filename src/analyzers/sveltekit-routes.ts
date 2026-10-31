import { posix } from "node:path";
import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import {
  definition,
  exportedValue,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  objectLiteral,
  type PathAlias,
  pathAliases,
  propertyValue,
  resolveImport,
  unwrap,
} from "./fastify-plugins.js";
import { importsTrpcAdapter } from "./trpc-syntax.js";

/**
 * SvelteKit's file-based routing as the API analyzer needs it: where routes
 * and hooks live (svelte.config.js), which URL a route directory serves, the
 * request handlers a +server file exports, the form actions of a
 * +page.server file, and the load functions of server layouts and pages.
 */

/** The exports of a +server file that handle requests. */
const ENDPOINT_EXPORTS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "QUERY",
  "fallback",
];
const CONFIG_FILES = ["js", "mjs", "cjs", "ts"].map(
  (extension) => `svelte.config.${extension}`,
);
/** `$lib` is built in; `#lib` comes from package.json `imports` in newer apps. */
const LIB_ALIASES: readonly PathAlias[] = [
  { prefix: "$lib/", suffix: "", targets: ["src/lib/*"] },
  { prefix: "$lib", suffix: "", targets: ["src/lib"] },
];
const GROUP = /^\(.*\)$/;
/** Bounds wrapper and alias chains around a handler; real code needs a few. */
const MAX_HANDLER_DEPTH = 6;

export type HandlerFunction = Node;

export interface KitConfig {
  /** The routes directory, project-relative: `src/routes`. */
  routes: string;
  /** The server hooks module without extension: `src/hooks.server`. */
  serverHooks: string;
  /** `checkOrigin: false`, or a `trustedOrigins` entry of '*'. */
  csrf: { setting: "checkOrigin" | "trustedOrigins"; node: Node } | null;
  file: string | null;
}

export interface Route {
  /** The URL pattern without groups: `/admin/users/[id]`. */
  path: string;
  /** SvelteKit's route id, which keeps groups: `/(app)/admin/users/[id]`. */
  id: string;
  /** The route directory: `src/routes/(app)/admin/users/[id]`. */
  directory: string;
}

export interface RequestHandler extends Route {
  kind: "endpoint" | "action";
  /** The export name for endpoints (`POST`, `fallback`); `POST` for actions. */
  method: string;
  /** The action name: `default` or a named action. */
  action?: string;
  file: string;
  line: number;
  /** The function answering the request, or undefined when not resolvable. */
  fn: HandlerFunction | undefined;
  /** Calls wrapped around the function, such as `withAuth(handler)`. */
  wrappers: CallExpression[];
}

export interface LoadFunction {
  file: string;
  fn: HandlerFunction;
}

export interface Routes {
  /** +server and +page.server files that hold request handlers. */
  files: string[];
  handlers: RequestHandler[];
  /** +server files whose handlers cannot be listed (`export *`). */
  opaqueFiles: number;
  /** Server layout and page load functions by route directory. */
  layouts: ReadonlyMap<string, LoadFunction>;
  pages: ReadonlyMap<string, LoadFunction>;
}

function normalizedPath(value: string): string {
  return posix.normalize(value).replace(/^\.\//, "").replace(/\/+$/, "");
}

function property(
  object: ObjectLiteralExpression | undefined,
  name: string,
): Node | undefined {
  return propertyValue(object?.getProperty(name)) ?? undefined;
}

function nested(
  index: ModuleIndex,
  object: ObjectLiteralExpression | undefined,
  name: string,
): ObjectLiteralExpression | undefined {
  return objectLiteral(index, property(object, name));
}

/** `export default config`, `export default { ... }`, or a call wrapping one. */
function configObject(
  index: ModuleIndex,
  sourceFile: SourceFile,
): ObjectLiteralExpression | undefined {
  const value = exportedValue(sourceFile, "default");
  const target = value && unwrap(value);
  if (Node.isCallExpression(target)) {
    return objectLiteral(index, target.getArguments()[0]);
  }
  return objectLiteral(index, target);
}

function csrfSetting(
  index: ModuleIndex,
  kit: ObjectLiteralExpression | undefined,
): KitConfig["csrf"] {
  const csrf = nested(index, kit, "csrf");
  const checkOrigin = csrf?.getProperty("checkOrigin");
  if (
    checkOrigin &&
    property(csrf, "checkOrigin")?.getKind() === SyntaxKind.FalseKeyword
  ) {
    return { setting: "checkOrigin", node: checkOrigin };
  }
  const origins = property(csrf, "trustedOrigins");
  const list = origins && unwrap(origins);
  const wildcard = Node.isArrayLiteralExpression(list)
    ? list.getElements().find((element) => literalText(element) === "*")
    : undefined;
  return wildcard ? { setting: "trustedOrigins", node: wildcard } : null;
}

/** Routes, hooks, and CSRF settings from svelte.config.js, or the defaults. */
export function readKitConfig(
  context: ScanContext,
  index: ModuleIndex,
): KitConfig {
  const defaults: KitConfig = {
    routes: "src/routes",
    serverHooks: "src/hooks.server",
    csrf: null,
    file: null,
  };
  const file = CONFIG_FILES.find((name) => context.files().includes(name));
  const sourceFile = file ? context.getSourceFile(file) : null;
  if (!file || !sourceFile) return defaults;
  const kit = nested(index, configObject(index, sourceFile), "kit");
  const files = nested(index, kit, "files");
  const routes = literalText(property(files, "routes"));
  const hooks = literalText(property(nested(index, files, "hooks"), "server"));
  return {
    routes: routes === null ? defaults.routes : normalizedPath(routes),
    serverHooks:
      hooks === null
        ? defaults.serverHooks
        : normalizedPath(hooks).replace(/\.[cm]?[jt]s$/, ""),
    csrf: csrfSetting(index, kit),
    file,
  };
}

/** package.json `imports` such as `"#lib/*": "./src/lib/*"`. */
function packageImports(context: ScanContext): PathAlias[] {
  const pkg = context.packageJson;
  const imports: unknown = pkg && "imports" in pkg ? pkg.imports : undefined;
  if (typeof imports !== "object" || imports === null) return [];
  return Object.entries(imports).flatMap(([pattern, value]) => {
    const target =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null && "default" in value
          ? value.default
          : undefined;
    const [prefix = "", suffix = "", ...rest] = pattern.split("*");
    if (!pattern.startsWith("#") || typeof target !== "string" || rest.length) {
      return [];
    }
    return [{ prefix, suffix, targets: [normalizedPath(target)] }];
  });
}

/**
 * Import aliases of a SvelteKit project: tsconfig paths, package.json
 * imports, and `$lib`, whose tsconfig entry lives in the generated
 * .svelte-kit directory a checkout does not have. Wildcard patterns come
 * first, so `$lib/server/auth` does not resolve to `$lib` itself.
 */
export function svelteKitAliases(context: ScanContext): PathAlias[] {
  const typescript = context.typescriptConfig();
  const configured =
    typescript.status === "ok"
      ? pathAliases(typescript.options, context.projectPath)
      : [];
  const isExact = (alias: PathAlias) =>
    alias.targets.every((target) => !target.includes("*"));
  return [...configured, ...packageImports(context), ...LIB_ALIASES].sort(
    (left, right) => Number(isExact(left)) - Number(isExact(right)),
  );
}

/** The route a file in a route directory belongs to. */
export function routeOf(file: string, routes: string): Route | null {
  if (!file.startsWith(`${routes}/`)) return null;
  const segments = file.slice(routes.length + 1).split("/");
  segments.pop();
  return {
    path: `/${segments.filter((segment) => !GROUP.test(segment)).join("/")}`,
    id: `/${segments.join("/")}`,
    directory: [routes, ...segments].join("/"),
  };
}

interface HandlerValue {
  fn: HandlerFunction | undefined;
  wrappers: CallExpression[];
}

/**
 * The function an export holds: directly, through variables and imports, or
 * as the last function argument of a wrapper such as `withAuth(handler)`.
 */
function handlerValue(
  index: ModuleIndex,
  node: Node | undefined,
  wrappers: CallExpression[] = [],
  depth = 0,
): HandlerValue {
  if (!node || depth > MAX_HANDLER_DEPTH) return { fn: undefined, wrappers };
  const value = Node.isVariableDeclaration(node) ? node.getInitializer() : node;
  const target = value && unwrap(value);
  if (!target) return { fn: undefined, wrappers };
  if (isFunctionLike(target) || Node.isMethodDeclaration(target)) {
    return { fn: target, wrappers };
  }
  if (Node.isCallExpression(target)) {
    for (const argument of [...target.getArguments()].reverse()) {
      const inner = handlerValue(
        index,
        argument,
        [...wrappers, target],
        depth + 1,
      );
      if (inner.fn) return inner;
    }
    return { fn: undefined, wrappers: [...wrappers, target] };
  }
  const resolved = definition(index, target);
  return resolved && resolved !== target
    ? handlerValue(index, resolved, wrappers, depth + 1)
    : { fn: undefined, wrappers };
}

/**
 * An export of a module and the line that names it: the declaration, or the
 * `export { handler as POST }` specifier, also re-exported from a project file.
 */
function exported(
  index: ModuleIndex,
  sourceFile: SourceFile,
  name: string,
): { node: Node; line: number } | null {
  const local = exportedValue(sourceFile, name);
  const nameNode =
    Node.isFunctionDeclaration(local) || Node.isVariableDeclaration(local)
      ? local.getNameNode()
      : undefined;
  if (local && nameNode?.getText() === name) {
    return { node: local, line: nameNode.getStartLineNumber() };
  }
  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration
      .getNamedExports()
      .find(
        (candidate) =>
          (candidate.getAliasNode()?.getText() ?? candidate.getName()) === name,
      );
    if (!specifier) continue;
    const from = declaration.getModuleSpecifierValue();
    const target = from ? resolveImport(index, sourceFile, from) : undefined;
    const value =
      local ?? (target && exportedValue(target, specifier.getName()));
    return { node: value ?? specifier, line: specifier.getStartLineNumber() };
  }
  if (local) return { node: local, line: local.getStartLineNumber() };
  // export const { GET, POST } = createHandlers(): exported, but not readable.
  const binding = sourceFile
    .getVariableStatements()
    .filter((statement) => statement.isExported())
    .flatMap((statement) =>
      statement.getDescendantsOfKind(SyntaxKind.BindingElement),
    )
    .find((element) => element.getName() === name);
  return binding ? { node: binding, line: binding.getStartLineNumber() } : null;
}

function endpointHandlers(
  index: ModuleIndex,
  sourceFile: SourceFile,
  file: string,
  route: Route,
): RequestHandler[] {
  return ENDPOINT_EXPORTS.flatMap((method) => {
    const found = exported(index, sourceFile, method);
    if (!found) return [];
    const { fn, wrappers } = handlerValue(index, found.node);
    return [
      { ...route, kind: "endpoint" as const, method, file, line: found.line },
    ].map((handler) => ({ ...handler, fn, wrappers }));
  });
}

interface ActionProperty {
  name: string;
  line: number;
  value: Node | undefined;
}

/** The actions object's members, with spread objects merged in. */
function actionProperties(
  index: ModuleIndex,
  object: ObjectLiteralExpression | undefined,
  depth = 0,
): ActionProperty[] {
  if (!object || depth > MAX_HANDLER_DEPTH) return [];
  return object.getProperties().flatMap((member): ActionProperty[] => {
    if (Node.isSpreadAssignment(member)) {
      return actionProperties(
        index,
        objectLiteral(index, member.getExpression()),
        depth + 1,
      );
    }
    if (
      !Node.isPropertyAssignment(member) &&
      !Node.isShorthandPropertyAssignment(member) &&
      !Node.isMethodDeclaration(member)
    ) {
      return [];
    }
    const nameNode = member.getNameNode();
    if (Node.isComputedPropertyName(nameNode)) return [];
    return [
      {
        name: literalText(nameNode) ?? nameNode.getText(),
        line: nameNode.getStartLineNumber(),
        value: Node.isShorthandPropertyAssignment(member)
          ? definition(index, member)
          : (propertyValue(member) ?? undefined),
      },
    ];
  });
}

function actionHandlers(
  index: ModuleIndex,
  sourceFile: SourceFile,
  file: string,
  route: Route,
): RequestHandler[] {
  const actions = exported(index, sourceFile, "actions");
  if (!actions) return [];
  return actionProperties(index, objectLiteral(index, actions.node)).map(
    ({ name, line, value }) => ({
      ...route,
      kind: "action" as const,
      method: "POST",
      action: name,
      file,
      line,
      ...handlerValue(index, value),
    }),
  );
}

function loadFunctions(
  context: ScanContext,
  index: ModuleIndex,
  routes: string,
  kind: "layout" | "page",
): Map<string, LoadFunction> {
  const loads = new Map<string, LoadFunction>();
  for (const file of context.matchFiles(
    `${routes}/**/+${kind}.server.{ts,js}`,
  )) {
    const sourceFile = context.getSourceFile(file);
    const route = routeOf(file, routes);
    const load = sourceFile && exported(index, sourceFile, "load");
    const { fn } = handlerValue(index, load?.node);
    if (route && fn) loads.set(route.directory, { file, fn });
  }
  return loads;
}

/** Every +server handler and form action under the routes directory. */
export function discoverRoutes(
  context: ScanContext,
  index: ModuleIndex,
  config: KitConfig,
): Routes {
  const files: string[] = [];
  const handlers: RequestHandler[] = [];
  let opaqueFiles = 0;
  for (const file of context.matchFiles([
    `${config.routes}/**/+server.{ts,js}`,
    `${config.routes}/**/+page.server.{ts,js}`,
  ])) {
    const sourceFile = context.getSourceFile(file);
    const route = routeOf(file, config.routes);
    if (!sourceFile || !route) continue;
    if (/\/\+server\.[jt]s$/.test(file)) {
      // A tRPC handler's endpoints are its procedures, checked by trpc-api.ts.
      if (importsTrpcAdapter(sourceFile)) continue;
      files.push(file);
      handlers.push(...endpointHandlers(index, sourceFile, file, route));
      if (
        sourceFile.getExportDeclarations().some((d) => d.isNamespaceExport())
      ) {
        opaqueFiles++;
      }
    } else {
      const actions = actionHandlers(index, sourceFile, file, route);
      if (actions.length > 0) files.push(file);
      handlers.push(...actions);
    }
  }
  return {
    files,
    handlers,
    opaqueFiles,
    layouts: loadFunctions(context, index, config.routes, "layout"),
    pages: loadFunctions(context, index, config.routes, "page"),
  };
}

/** The server hooks file, or null when the app has none. */
export function serverHooksFile(
  context: ScanContext,
  config: KitConfig,
): string | null {
  const candidates = ["ts", "js", "mts", "mjs"].flatMap((extension) => [
    `${config.serverHooks}.${extension}`,
    `${config.serverHooks}/index.${extension}`,
  ]);
  const files = new Set(context.files());
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** The node a module exports as `name`, through project re-exports. */
export function exportedNode(
  index: ModuleIndex,
  sourceFile: SourceFile,
  name: string,
): Node | undefined {
  return exported(index, sourceFile, name)?.node;
}
