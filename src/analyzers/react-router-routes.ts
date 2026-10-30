import { posix } from "node:path";
import { Minimatch } from "minimatch";
import { type CallExpression, Node } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import {
  definition,
  exportedValue,
  importSource,
  literalText,
  type ModuleIndex,
  moduleOf,
  objectLiteral,
  propertyValue,
  unwrap,
} from "./fastify-plugins.js";
import { joinPath, literals } from "./hono-apps.js";

/**
 * Finds the route modules of a React Router framework-mode or Remix app and
 * the URL each one serves: from app/routes.ts where its route(), index(),
 * layout(), and prefix() calls have literal arguments, and from the
 * app/routes file convention for flatRoutes() or a Remix app without a route
 * config. Each route keeps its parent, because a parent route's middleware
 * runs for its children's actions and loaders.
 */

export interface RouteNode {
  /** The project-relative route module, or null for a root route without one. */
  readonly file: string | null;
  /** The URL pattern, such as /projects/:projectId. */
  readonly path: string;
  readonly parent: RouteNode | null;
}

export interface RouteTree {
  /** Every route with a module, parents before their children. */
  readonly nodes: readonly RouteNode[];
  /** The route config file, when the app has one. */
  readonly config: string | null;
  /** Entries of the route config that are not statically resolvable. */
  readonly unresolved: number;
}

/** Modules exporting route(), index(), layout(), and prefix(). */
const CONFIG_MODULES = new Set([
  "@react-router/dev/routes",
  "@remix-run/route-config",
]);
const FS_ROUTES_MODULES = new Set([
  "@react-router/fs-routes",
  "@remix-run/fs-routes",
]);
const SCRIPT_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const ROUTE_FILE = /\.(?:jsx?|tsx?)$/;
/** A folder route's module: app/routes/app.projects/route.tsx. */
const FOLDER_ROUTE_FILE = /^(?:route|index)\.(?:jsx?|tsx?)$/;
/** Never served, even inside the routes directory. */
const NOT_A_ROUTE = /\.(?:test|spec)\.[jt]sx?$|\.d\.ts$/;
const INDEX_ROUTE = /(?:^|\.)_index$/;
/** Files that may set a non-default app directory. */
const APP_CONFIG_FILES = [
  ...["ts", "js", "mjs", "mts"].map((ext) => `react-router.config.${ext}`),
  ...["ts", "js", "mjs", "mts"].map((ext) => `vite.config.${ext}`),
  ...["js", "mjs", "cjs"].map((ext) => `remix.config.${ext}`),
];
const APP_DIRECTORY = /\bappDirectory\s*:\s*["'`]([^"'`]+)["'`]/;
/** Bounds nested arrays and variables in a route config. */
const MAX_CONFIG_DEPTH = 16;

type Segment = { value: string; raw: string };

/**
 * Splits a flat route name into URL segments like React Router's
 * getRouteSegments: `.` separates segments, `[...]` escapes characters,
 * `(...)` marks an optional segment, and a leading `$` is a parameter or,
 * at the very end, a splat.
 */
function flatSegments(name: string): Segment[] {
  const segments: Segment[] = [];
  let value = "";
  let raw = "";
  let state: "normal" | "escape" | "optional" | "optionalEscape" = "normal";
  const push = () => {
    if (raw !== "") segments.push({ value, raw });
    value = "";
    raw = "";
  };
  for (let position = 0; position < name.length; position++) {
    const char = name.charAt(position);
    const parameter = value === "" && char === "$";
    const splat = position === name.length - 1;
    if (state === "normal" && (char === "." || char === "/")) {
      push();
      continue;
    }
    raw += char;
    if (state === "escape" || state === "optionalEscape") {
      if (char === "]") state = state === "escape" ? "normal" : "optional";
      else value += char;
    } else if (char === "[") {
      state = state === "normal" ? "escape" : "optionalEscape";
    } else if (state === "normal" && char === "(") {
      state = "optional";
    } else if (state === "optional" && char === ")") {
      value += "?";
      state = "normal";
    } else if (parameter) {
      value += splat ? "*" : ":";
    } else {
      value += char;
    }
  }
  push();
  return segments;
}

/**
 * The URL pattern of a flat route file name without its extension, such as
 * `concerts.$city` for /concerts/:city. Segments starting with `_` add no
 * path (pathless layouts and `_index`); a trailing `_` only opts out of
 * nesting. Escaped underscores are kept.
 */
export function flatRoutePath(name: string): string {
  const path = flatSegments(name).flatMap(({ value, raw }) => {
    if (value.startsWith("_") && raw.startsWith("_")) return [];
    return [
      value.endsWith("_") && raw.endsWith("_") ? value.slice(0, -1) : value,
    ];
  });
  return `/${path.join("/")}`;
}

/** Joins a prefix() path and a route path like React Router's joinRoutePaths. */
function prefixed(prefix: string, path: string): string {
  if (prefix === "") return path;
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The full URL of a route path declared under a parent. */
function fullPath(parent: RouteNode, prefix: string, path: string): string {
  const relative = prefixed(prefix, path);
  // An absolute child path already contains its parent's path.
  return joinPath(relative.startsWith("/") ? "/" : parent.path, relative);
}

function normalizedDirectory(directory: string): string | null {
  const normalized = posix
    .normalize(directory.replace(/\\/g, "/"))
    .replace(/^\.\/|\/+$/g, "");
  return normalized === "" ||
    normalized === "." ||
    normalized.startsWith("..") ||
    posix.isAbsolute(normalized)
    ? null
    : normalized;
}

/** The app directory: `appDirectory` from the framework config, or app. */
function appDirectory(
  context: ScanContext,
  files: ReadonlySet<string>,
): string {
  for (const file of APP_CONFIG_FILES) {
    if (!files.has(file)) continue;
    const configured = APP_DIRECTORY.exec(context.readText(file) ?? "")?.[1];
    const directory = configured && normalizedDirectory(configured);
    if (directory) return directory;
  }
  return "app";
}

function firstFile(
  files: ReadonlySet<string>,
  stem: string,
  extensions: readonly string[],
): string | null {
  return (
    extensions
      .map((extension) => `${stem}.${extension}`)
      .find((file) => files.has(file)) ?? null
  );
}

/** A flat route's name: `concerts.$city` for routes/concerts.$city.tsx or routes/concerts.$city/route.tsx. */
function flatRouteName(relative: string): string | null {
  const parts = relative.split("/");
  const [first = "", second] = parts;
  if (parts.length === 1 && ROUTE_FILE.test(first)) {
    return first.replace(ROUTE_FILE, "");
  }
  return parts.length === 2 && second && FOLDER_ROUTE_FILE.test(second)
    ? first
    : null;
}

/**
 * The routes of the flat file convention under `<app>/<directory>`. A route
 * nests under the longest other route name that prefixes it followed by a
 * dot; index routes have no children. Folders ending in `+` belong to
 * remix-flat-routes, whose convention this scan does not read; they are
 * counted as unresolved.
 */
function flatRouteNodes(
  files: readonly string[],
  app: string,
  directory: string,
  ignored: readonly Minimatch[],
  parent: RouteNode,
  base: string,
): { nodes: RouteNode[]; unresolved: number } {
  const root = posix.join(app, directory);
  const modules = new Map<string, string>();
  const plusFolders = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(`${root}/`) || NOT_A_ROUTE.test(file)) continue;
    const relative = file.slice(root.length + 1);
    const folder = relative.split("/")[0] ?? "";
    if (folder.endsWith("+") && relative.includes("/")) {
      plusFolders.add(folder);
      continue;
    }
    const name = flatRouteName(relative);
    if (name === null || modules.has(name)) continue;
    // ignoredRouteFiles globs are relative to the app directory.
    const candidates = [
      posix.join(directory, relative),
      posix.join(directory, name),
    ];
    if (ignored.some((glob) => candidates.some((path) => glob.match(path)))) {
      continue;
    }
    modules.set(name, file);
  }

  const names = [...modules.keys()].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const nodes = new Map<string, RouteNode>();
  for (const name of names) {
    const parentName = names
      .filter(
        (candidate) =>
          candidate.length < name.length &&
          !INDEX_ROUTE.test(candidate) &&
          name.startsWith(`${candidate}.`),
      )
      .at(-1);
    nodes.set(name, {
      file: modules.get(name) ?? null,
      path: joinPath(base, flatRoutePath(name)),
      parent: (parentName && nodes.get(parentName)) || parent,
    });
  }
  return { nodes: [...nodes.values()], unresolved: plusFolders.size };
}

interface Reader {
  readonly index: ModuleIndex;
  readonly files: readonly string[];
  readonly fileSet: ReadonlySet<string>;
  readonly app: string;
  readonly nodes: RouteNode[];
  unresolved: number;
}

/** The module and export a route config call refers to: `route`, `r.index`. */
function helperOf(
  call: CallExpression,
): { module: string; name: string } | null {
  const callee = unwrap(call.getExpression());
  if (Node.isIdentifier(callee)) {
    const declaration = callee.getSymbol()?.getDeclarations()[0];
    const source = declaration ? importSource(declaration) : null;
    return source && { module: source.specifier, name: source.name };
  }
  if (Node.isPropertyAccessExpression(callee)) {
    const module = moduleOf(callee.getExpression());
    return module === null ? null : { module, name: callee.getName() };
  }
  return null;
}

function addRoute(
  reader: Reader,
  file: string,
  path: string,
  parent: RouteNode,
): RouteNode {
  const resolved = posix.normalize(posix.join(reader.app, file));
  const node: RouteNode = {
    file: reader.fileSet.has(resolved) ? resolved : null,
    path,
    parent,
  };
  if (node.file) reader.nodes.push(node);
  return node;
}

/** route(path, file, children?) or route(path, file, options, children?). */
function childEntries(args: Node[], position: number): Node | undefined {
  const value = args[position] && unwrap(args[position]);
  return Node.isObjectLiteralExpression(value)
    ? args[position + 1]
    : args[position];
}

function readFlatRoutes(
  reader: Reader,
  options: Node | undefined,
  parent: RouteNode,
  prefix: string,
): void {
  const config = objectLiteral(reader.index, options);
  if (options && !config) {
    reader.unresolved++;
    return;
  }
  const directory =
    literalText(propertyValue(config?.getProperty("rootDirectory"))) ??
    "routes";
  const ignored = literals(
    propertyValue(config?.getProperty("ignoredRouteFiles")),
  ).map((glob) => new Minimatch(glob, { dot: true }));
  const normalized = normalizedDirectory(directory);
  if (!normalized) {
    reader.unresolved++;
    return;
  }
  const flat = flatRouteNodes(
    reader.files,
    reader.app,
    normalized,
    ignored,
    parent,
    fullPath(parent, prefix, ""),
  );
  reader.nodes.push(...flat.nodes);
  reader.unresolved += flat.unresolved;
}

function readCall(
  reader: Reader,
  call: CallExpression,
  parent: RouteNode,
  prefix: string,
  depth: number,
): void {
  const helper = helperOf(call);
  const args = call.getArguments();
  if (helper && FS_ROUTES_MODULES.has(helper.module)) {
    if (helper.name === "flatRoutes") {
      readFlatRoutes(reader, args[0], parent, prefix);
      return;
    }
  } else if (helper && CONFIG_MODULES.has(helper.module)) {
    const [first, second] = args.map((arg) => literalText(arg));
    if (helper.name === "route" && first != null && second != null) {
      const node = addRoute(
        reader,
        second,
        fullPath(parent, prefix, first),
        parent,
      );
      readEntries(reader, childEntries(args, 2), node, "", depth + 1);
      return;
    }
    if (helper.name === "index" && first != null) {
      addRoute(reader, first, fullPath(parent, prefix, ""), parent);
      return;
    }
    if (helper.name === "layout" && first != null) {
      // A layout adds no path; a prefix() around it applies to its children.
      const node = addRoute(reader, first, parent.path, parent);
      readEntries(reader, childEntries(args, 1), node, prefix, depth + 1);
      return;
    }
    if (helper.name === "prefix" && first != null) {
      readEntries(reader, args[1], parent, prefixed(prefix, first), depth + 1);
      return;
    }
  }
  reader.unresolved++;
}

/** A plain RouteConfigEntry: `{ path, file, index, children }`. */
function readObject(
  reader: Reader,
  entry: Node,
  parent: RouteNode,
  prefix: string,
  depth: number,
): void {
  const config = objectLiteral(reader.index, entry);
  const value = (key: string) => propertyValue(config?.getProperty(key));
  const file = literalText(value("file"));
  const path = literalText(value("path"));
  if (!config || file === null) {
    reader.unresolved++;
    return;
  }
  if (value("index")?.getText() === "true") {
    addRoute(reader, file, fullPath(parent, prefix, path ?? ""), parent);
    return;
  }
  const node =
    path === null
      ? addRoute(reader, file, parent.path, parent)
      : addRoute(reader, file, fullPath(parent, prefix, path), parent);
  readEntries(
    reader,
    value("children"),
    node,
    path === null ? prefix : "",
    depth + 1,
  );
}

/** Adds the routes a route config expression declares under a parent. */
function readEntries(
  reader: Reader,
  node: Node | undefined,
  parent: RouteNode,
  prefix: string,
  depth: number,
): void {
  if (!node) return;
  if (depth > MAX_CONFIG_DEPTH) {
    reader.unresolved++;
    return;
  }
  const value = unwrap(node);
  if (Node.isArrayLiteralExpression(value)) {
    for (const element of value.getElements()) {
      const entry = Node.isSpreadElement(element)
        ? element.getExpression()
        : element;
      readEntries(reader, entry, parent, prefix, depth + 1);
    }
  } else if (Node.isCallExpression(value)) {
    readCall(reader, value, parent, prefix, depth);
  } else if (Node.isObjectLiteralExpression(value)) {
    readObject(reader, value, parent, prefix, depth);
  } else if (Node.isIdentifier(value)) {
    // const adminRoutes = [...], also imported from another project file.
    const declared = definition(reader.index, value);
    if (Node.isVariableDeclaration(declared)) {
      readEntries(reader, declared.getInitializer(), parent, prefix, depth + 1);
    } else {
      reader.unresolved++;
    }
  } else {
    reader.unresolved++;
  }
}

/**
 * The app's routes. A route config replaces the file convention, which then
 * applies only where the config calls flatRoutes(); a Remix app without one
 * uses the file convention under app/routes.
 */
export function discoverRoutes(
  context: ScanContext,
  index: ModuleIndex,
): RouteTree {
  const files = context.files();
  const fileSet = new Set(files);
  const app = appDirectory(context, fileSet);
  const root: RouteNode = {
    file: firstFile(fileSet, `${app}/root`, SCRIPT_EXTENSIONS),
    path: "/",
    parent: null,
  };
  const reader: Reader = {
    index,
    files,
    fileSet,
    app,
    nodes: root.file ? [root] : [],
    unresolved: 0,
  };
  const config = firstFile(fileSet, `${app}/routes`, [
    "ts",
    "js",
    "mts",
    "mjs",
  ]);
  const configSource = config ? index.files.get(config) : undefined;
  if (config) {
    const routes = configSource && exportedValue(configSource, "default");
    if (routes) readEntries(reader, routes, root, "", 0);
    else reader.unresolved++;
  } else {
    readFlatRoutes(reader, undefined, root, "");
  }
  return { nodes: reader.nodes, config, unresolved: reader.unresolved };
}
