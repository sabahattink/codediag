import { posix } from "node:path";
import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  definition,
  exportedValue,
  literalText,
  moduleOf,
  objectLiteral,
  type PluginTarget,
  type ProjectIndex,
  pluginTarget,
  propertyValue,
  unwrap,
} from "./fastify-plugins.js";

/**
 * Models `fastify.register(AutoLoad, { dir })` as @fastify/autoload 6 loads
 * it: autoload shares the registering context, every script in the
 * directory tree is a plugin, directory names become route prefixes, an
 * index file replaces the other files of its directory, and with autoHooks
 * a directory's hooks wrap its plugins in a context of their own.
 * Patterns and filters given as regular expressions or functions are not
 * evaluated.
 */

const AUTOLOAD_MODULES = new Set(["@fastify/autoload", "fastify-autoload"]);
const SCRIPT = /\.[cm]?[jt]s$/i;
const DECLARATION = /\.d\.[cm]?ts$/i;
const INDEX = /^index\.[cm]?[jt]s$/i;
const AUTOHOOKS = /^[_.]?auto_?hooks\.[cm]?[jt]s$/i;
/** Values that stand for the directory of the file they appear in. */
const FILE_DIRECTORY = /^(?:__dirname|import\.meta\.dirname)$/;
/** Bounds the variables followed to find a directory; real code needs one. */
const MAX_DIRECTORY_DEPTH = 4;

export interface AutoloadPlugin {
  target: PluginTarget;
  /** The directory scope it is registered in; null for the registering context. */
  scope: string | null;
  prefix: string;
}

/** A directory whose autohooks wrap its plugins in their own context. */
export interface AutoloadScope {
  id: string;
  prefix: string;
  hooks: PluginTarget[];
}

export interface Autoload {
  scopes: AutoloadScope[];
  plugins: AutoloadPlugin[];
}

interface AutoloadOptions {
  dir: string;
  /** The `options.prefix` passed on to every loaded plugin. */
  prefix: string;
  encapsulate: boolean;
  dirNameRoutePrefix: boolean;
  autoHooks: boolean;
  cascadeHooks: boolean;
  overwriteHooks: boolean;
  routeParams: boolean;
  appendAutoPrefix: boolean;
  maxDepth: number;
  matchFilter: string | null;
  ignoreFilter: string | null;
}

interface Directory {
  scripts: string[];
  index?: string;
  hooks?: string;
}

const cache = new WeakMap<ProjectIndex, Map<CallExpression, Autoload | null>>();

function fileOf(index: ProjectIndex, node: Node): string | undefined {
  return index.paths.get(node.getSourceFile());
}

/** A path inside the project, or null when it leaves the project. */
function within(base: string, segments: string[]): string | null {
  const joined = posix.normalize(posix.join(base || ".", ...segments));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

/** `__dirname`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`, or `process.cwd()`. */
function baseDirectory(index: ProjectIndex, node: Node): string | null {
  const value = unwrap(node);
  const text = value.getText().replace(/\s/g, "");
  if (text === "process.cwd()") return "";
  const file = fileOf(index, value);
  if (file === undefined) return null;
  if (FILE_DIRECTORY.test(text)) return posix.dirname(file);
  // const here = dirname(fileURLToPath(import.meta.url))
  const resolved = definition(index, value);
  if (!Node.isVariableDeclaration(resolved)) return null;
  const initializer = resolved.getInitializer()?.getText() ?? "";
  const declared = fileOf(index, resolved);
  return /\bdirname\s*\(/.test(initializer) &&
    initializer.includes("import.meta.url") &&
    declared !== undefined
    ? posix.dirname(declared)
    : null;
}

function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : callee.getText();
}

/** The project directory an autoload `dir` value names. */
function directoryOf(
  index: ProjectIndex,
  node: Node | undefined,
  depth = 0,
): string | null {
  if (!node || depth > MAX_DIRECTORY_DEPTH) return null;
  const value = unwrap(node);
  if (Node.isIdentifier(value)) {
    const resolved = definition(index, value);
    return Node.isVariableDeclaration(resolved)
      ? directoryOf(index, resolved.getInitializer(), depth + 1)
      : null;
  }
  // new URL("./routes", import.meta.url), usually inside fileURLToPath()
  if (Node.isNewExpression(value)) {
    const [path, base] = value.getArguments();
    const relative = literalText(path);
    const file = fileOf(index, value);
    return relative !== null &&
      base?.getText() === "import.meta.url" &&
      file !== undefined
      ? within(posix.dirname(file), [relative])
      : null;
  }
  if (Node.isCallExpression(value)) {
    const name = calleeName(value);
    const [first, ...rest] = value.getArguments();
    if (name === "fileURLToPath") return directoryOf(index, first, depth + 1);
    if (name !== "join" && name !== "resolve") return null;
    const base = first ? baseDirectory(index, first) : null;
    const segments = rest.map(literalText);
    return base !== null && segments.every((segment) => segment !== null)
      ? within(base, segments as string[])
      : null;
  }
  // `${__dirname}/routes`
  if (Node.isTemplateExpression(value)) {
    const [span, ...others] = value.getTemplateSpans();
    if (!span || others.length > 0 || value.getHead().getLiteralText()) {
      return null;
    }
    const base = baseDirectory(index, span.getExpression());
    return base === null
      ? null
      : within(base, [span.getLiteral().getLiteralText()]);
  }
  return null;
}

function flag(options: ObjectLiteralExpression, name: string): boolean | null {
  const kind = propertyValue(options.getProperty(name))?.getKind();
  if (kind === SyntaxKind.TrueKeyword) return true;
  if (kind === SyntaxKind.FalseKeyword) return false;
  return null;
}

function readOptions(
  index: ProjectIndex,
  options: ObjectLiteralExpression,
): AutoloadOptions | null {
  const dir = directoryOf(index, propertyValue(options.getProperty("dir")));
  if (dir === null) return null;
  const pluginOptions = objectLiteral(
    index,
    propertyValue(options.getProperty("options")),
  );
  const prefix =
    literalText(propertyValue(pluginOptions?.getProperty("prefix"))) ?? "";
  const maxDepth = propertyValue(options.getProperty("maxDepth"));
  const text = (name: string) =>
    literalText(propertyValue(options.getProperty(name)));
  return {
    dir,
    prefix: prefix.replace(/\/$/, ""),
    encapsulate: flag(options, "encapsulate") ?? true,
    // A function renames directories; their names are the best estimate.
    dirNameRoutePrefix: flag(options, "dirNameRoutePrefix") ?? true,
    autoHooks: flag(options, "autoHooks") ?? false,
    cascadeHooks: flag(options, "cascadeHooks") ?? false,
    overwriteHooks: flag(options, "overwriteHooks") ?? false,
    routeParams: flag(options, "routeParams") ?? false,
    appendAutoPrefix: flag(options, "appendAutoPrefix") ?? false,
    maxDepth: Node.isNumericLiteral(maxDepth)
      ? maxDepth.getLiteralValue()
      : Number.POSITIVE_INFINITY,
    matchFilter: text("matchFilter"),
    ignoreFilter: text("ignoreFilter"),
  };
}

/** Script files under the autoload directory, grouped by subdirectory. */
function directories(
  index: ProjectIndex,
  options: AutoloadOptions,
): Map<string, Directory> {
  const found = new Map<string, Directory>();
  const root = options.dir ? `${options.dir}/` : "";
  for (const file of [...index.files.keys()].sort()) {
    if (!file.startsWith(root)) continue;
    const relative = file.slice(root.length);
    const segments = relative.split("/");
    const name = segments.pop() ?? "";
    if (segments.length > options.maxDepth) continue;
    if (!SCRIPT.test(name) || DECLARATION.test(name)) continue;
    const path = segments.join("/");
    const directory = found.get(path) ?? { scripts: [] };
    found.set(path, directory);
    if (AUTOHOOKS.test(name)) {
      if (options.autoHooks) directory.hooks = file;
      continue;
    }
    const filtered =
      (options.matchFilter !== null &&
        !`/${relative}`.includes(options.matchFilter)) ||
      (options.ignoreFilter !== null &&
        `/${relative}`.includes(options.ignoreFilter));
    if (filtered) continue;
    if (INDEX.test(name)) directory.index = file;
    else directory.scripts.push(file);
  }
  return found;
}

/** The autohooks that apply to a directory, inherited when cascaded. */
function hooksOf(
  path: string,
  found: Map<string, Directory>,
  options: AutoloadOptions,
): string[] {
  const parent = path.includes("/") ? posix.dirname(path) : "";
  const inherited =
    options.cascadeHooks && path !== "" ? hooksOf(parent, found, options) : [];
  const own = found.get(path)?.hooks;
  if (!own) return inherited;
  return options.overwriteHooks ? [own] : [...inherited, own];
}

function exportedLiteral(
  sourceFile: SourceFile,
  name: string,
): Node | undefined {
  const value = exportedValue(sourceFile, name);
  return Node.isVariableDeclaration(value) ? value.getInitializer() : value;
}

/** The prefix autoload passes to a plugin, from its directory and exports. */
function pluginPrefix(
  sourceFile: SourceFile,
  directory: string,
  options: AutoloadOptions,
): string {
  const override = literalText(exportedLiteral(sourceFile, "prefixOverride"));
  if (override !== null) return override;
  const directoryPrefix =
    options.dirNameRoutePrefix && directory ? `/${directory}` : "";
  const autoPrefix = literalText(exportedLiteral(sourceFile, "autoPrefix"));
  const prefix =
    autoPrefix === null
      ? directoryPrefix
      : options.appendAutoPrefix && directoryPrefix
        ? `${directoryPrefix}/${autoPrefix}`
        : autoPrefix;
  const combined = prefix
    ? `${options.prefix}${prefix.replace(/\/+/g, "/")}`
    : options.prefix;
  return options.routeParams && combined
    ? combined.replace(/__/g, ":").replace(/\/_/g, "/:")
    : combined;
}

function loadedPlugin(
  index: ProjectIndex,
  file: string,
): { sourceFile: SourceFile; target: PluginTarget } | null {
  const sourceFile = index.files.get(file);
  if (!sourceFile) return null;
  if (
    exportedLiteral(sourceFile, "autoload")?.getKind() ===
    SyntaxKind.FalseKeyword
  ) {
    return null;
  }
  const target = pluginTarget(index, exportedValue(sourceFile, "default"));
  return target ? { sourceFile, target } : null;
}

function load(index: ProjectIndex, call: CallExpression): Autoload | null {
  const [plugin, rawOptions] = call.getArguments();
  if (!plugin || !AUTOLOAD_MODULES.has(moduleOf(plugin) ?? "")) return null;
  const optionsObject = objectLiteral(index, rawOptions);
  const options = optionsObject ? readOptions(index, optionsObject) : null;
  // An autoload whose directory cannot be resolved loads nothing we can see.
  if (!options) return { scopes: [], plugins: [] };

  const found = directories(index, options);
  const autoload: Autoload = { scopes: [], plugins: [] };
  for (const [path, directory] of [...found].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const files = directory.index ? [directory.index] : directory.scripts;
    const plugins = files.flatMap((file) => {
      const loaded = loadedPlugin(index, file);
      if (!loaded) return [];
      return [
        {
          target: options.encapsulate
            ? loaded.target
            : { ...loaded.target, encapsulated: false },
          prefix: pluginPrefix(loaded.sourceFile, path, options),
        },
      ];
    });
    const hooks = hooksOf(path, found, options).flatMap((file) => {
      const loaded = loadedPlugin(index, file);
      // Autoload registers hooks without encapsulation, like fastify-plugin.
      return loaded ? [{ ...loaded.target, encapsulated: false }] : [];
    });
    if (hooks.length === 0) {
      for (const entry of plugins) {
        autoload.plugins.push({ ...entry, scope: null });
      }
      continue;
    }
    // Directories with hooks are wrapped in a context that carries their
    // plugins' prefix when all of them share it.
    const prefixes = plugins.map((entry) => entry.prefix).filter(Boolean);
    const shared =
      prefixes.length > 0 && prefixes.every((prefix) => prefix === prefixes[0])
        ? (prefixes[0] ?? "")
        : "";
    const id = `${fileOf(index, call)}:${call.getStart()}:autoload/${path}`;
    autoload.scopes.push({ id, prefix: shared, hooks });
    for (const entry of plugins) {
      autoload.plugins.push({
        ...entry,
        scope: id,
        prefix: entry.prefix.startsWith(shared)
          ? entry.prefix.slice(shared.length)
          : entry.prefix,
      });
    }
  }
  return autoload;
}

/** What a register() call loads through @fastify/autoload, or null. */
export function autoloadOf(
  index: ProjectIndex,
  call: CallExpression,
): Autoload | null {
  let calls = cache.get(index);
  if (!calls) {
    calls = new Map();
    cache.set(index, calls);
  }
  if (!calls.has(call)) calls.set(call, load(index, call));
  return calls.get(call) ?? null;
}

/** Every plugin an autoload registers, including its hooks. */
export function autoloadedPlugins(
  index: ProjectIndex,
  call: CallExpression,
): PluginTarget[] | null {
  const autoload = autoloadOf(index, call);
  return autoload
    ? [
        ...autoload.scopes.flatMap((scope) => scope.hooks),
        ...autoload.plugins.map((entry) => entry.target),
      ]
    : null;
}
