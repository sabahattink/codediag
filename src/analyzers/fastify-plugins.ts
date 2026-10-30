import { posix } from "node:path";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

/**
 * Resolves Fastify instances and plugin encapsulation contexts across a
 * project: which variables hold an instance, which functions are plugins,
 * and which context a receiver such as `fastify` in `fastify.get()` is.
 */

/** Receivers matched only by name, when their creation cannot be resolved. */
const INSTANCE_NAMES = /(?:^|\.)(?:app|server|fastify|instance)$/i;
const INSTANCE_TYPE = /^(?:[A-Za-z_$][\w$]*\.)?FastifyInstance\b/;
const PLUGIN_TYPE = /^(?:[A-Za-z_$][\w$]*\.)?FastifyPlugin\w*/;
/** Instance methods that return the instance, so calls can be chained. */
const CHAINABLE =
  /^(?:register|addHook|addSchema|decorate\w*|set\w*Handler|withTypeProvider)$/;
/** Variables initialized from an HTTP client, such as `got.extend()`. */
const HTTP_CLIENT =
  /\b(?:axios|got|ky|superagent|ofetch|undici|needle)\b|\bfetch\s*\(|\.create\s*\(/;
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];
/** Bounds alias, import, and re-export chains; real code needs a few hops. */
const MAX_RESOLUTION_DEPTH = 8;

export type Confidence = "high" | "low";
export type FunctionLike =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression;

export interface Instance {
  /** The encapsulation context: a root instance or a plugin function. */
  context: string;
  confidence: Confidence;
}

export interface PluginTarget {
  fn: FunctionLike;
  /** False for fastify-plugin, which shares the registering context. */
  encapsulated: boolean;
}

/** Project files by path, for following imports between them. */
export interface ModuleIndex {
  readonly paths: ReadonlyMap<SourceFile, string>;
  readonly files: ReadonlyMap<string, SourceFile>;
}

export interface ProjectIndex extends ModuleIndex {
  /** Variables holding instances created by Fastify() or typed FastifyInstance. */
  readonly roots: ReadonlyMap<Node, string>;
  /** Plugin functions and the context each one runs in. */
  readonly plugins: ReadonlyMap<Node, string>;
}

export function literalText(node: Node | undefined): string | null {
  return node &&
    (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    ? node.getLiteralText()
    : null;
}

function requiredModule(node: Node | undefined): string | null {
  if (!node || !Node.isCallExpression(node)) return null;
  if (node.getExpression().getText() !== "require") return null;
  return literalText(node.getArguments()[0]);
}

export function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  );
}

/** Strips syntax that does not change a value: await, parentheses, casts. */
export function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isAwaitExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** Follows calls that return their receiver: `Fastify().withTypeProvider()`. */
function chainRoot(node: Node): Node {
  let current = unwrap(node);
  while (Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      !CHAINABLE.test(callee.getName())
    ) {
      break;
    }
    current = unwrap(callee.getExpression());
  }
  return current;
}

export function methodName(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
}

export function receiverOf(call: CallExpression): Node {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee)
    ? callee.getExpression()
    : callee;
}

/** The module and export an import or require() binding refers to. */
export function importSource(
  declaration: Node,
): { specifier: string; name: string } | null {
  if (
    Node.isImportClause(declaration) ||
    Node.isImportSpecifier(declaration) ||
    Node.isNamespaceImport(declaration)
  ) {
    const specifier = declaration
      .getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      ?.getModuleSpecifierValue();
    if (specifier === undefined) return null;
    if (Node.isImportSpecifier(declaration)) {
      return { specifier, name: declaration.getName() };
    }
    return {
      specifier,
      name: Node.isImportClause(declaration) ? "default" : "*",
    };
  }
  const variable = Node.isBindingElement(declaration)
    ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    : declaration;
  if (!Node.isVariableDeclaration(variable)) return null;
  const specifier = requiredModule(variable.getInitializer());
  if (specifier === null) return null;
  const name = Node.isBindingElement(declaration)
    ? (declaration.getPropertyNameNode()?.getText() ?? declaration.getName())
    : "default";
  return { specifier, name };
}

/** The package an expression comes from: `Fastify`, `require("fastify")`. */
export function moduleOf(node: Node): string | null {
  const value = unwrap(node);
  if (Node.isCallExpression(value)) return requiredModule(value);
  if (Node.isPropertyAccessExpression(value)) {
    return moduleOf(value.getExpression());
  }
  if (!Node.isIdentifier(value)) return null;
  const declaration = value.getSymbol()?.getDeclarations()[0];
  return declaration ? (importSource(declaration)?.specifier ?? null) : null;
}

function resolveImport(
  index: ModuleIndex,
  from: SourceFile,
  specifier: string,
): SourceFile | undefined {
  const fromFile = index.paths.get(from);
  if (!fromFile || !specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  const match = candidates.find((candidate) => index.files.has(candidate));
  return match ? index.files.get(match) : undefined;
}

/** The node a module exports under a name ("default" for module.exports). */
function exportedValue(sourceFile: SourceFile, name: string): Node | undefined {
  const isDefault = name === "default";
  const fn = sourceFile
    .getFunctions()
    .find((candidate) =>
      isDefault
        ? candidate.isDefaultExport()
        : candidate.isExported() && candidate.getName() === name,
    );
  if (fn) return fn;
  const assignment = isDefault
    ? sourceFile.getExportAssignments()[0]?.getExpression()
    : undefined;
  if (assignment) return assignment;
  const variable = sourceFile.getVariableDeclaration(name);
  if (variable?.isExported()) return variable;
  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifier()) continue;
    const specifier = declaration
      .getNamedExports()
      .find(
        (candidate) =>
          (candidate.getAliasNode()?.getText() ?? candidate.getName()) === name,
      );
    if (specifier) return specifier.getLocalTargetDeclarations()[0];
  }
  for (const binary of sourceFile.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      continue;
    }
    const target = binary.getLeft().getText();
    const exported =
      target === "module.exports"
        ? "default"
        : /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target)?.[1];
    if (exported === name) return binary.getRight();
  }
  return undefined;
}

/**
 * The node that defines a value: identifiers are followed to their local
 * declaration, and imports of project files to what that file exports.
 */
export function definition(
  index: ModuleIndex,
  node: Node,
  depth = 0,
): Node | undefined {
  const value = unwrap(node);
  const symbol = Node.isShorthandPropertyAssignment(value)
    ? value.getValueSymbol()
    : Node.isIdentifier(value)
      ? value.getSymbol()
      : null;
  if (symbol === null) return value;
  const declaration = symbol?.getDeclarations()[0];
  const source = declaration ? importSource(declaration) : null;
  if (!declaration || !source) return declaration;
  const target =
    depth < MAX_RESOLUTION_DEPTH
      ? resolveImport(index, declaration.getSourceFile(), source.specifier)
      : undefined;
  const exported = target ? exportedValue(target, source.name) : undefined;
  return exported ? definition(index, exported, depth + 1) : undefined;
}

export function objectLiteral(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): ObjectLiteralExpression | undefined {
  if (!node || depth > MAX_RESOLUTION_DEPTH) return undefined;
  const value = definition(index, node);
  if (Node.isVariableDeclaration(value)) {
    return objectLiteral(index, value.getInitializer(), depth + 1);
  }
  return Node.isObjectLiteralExpression(value) ? value : undefined;
}

export function propertyValue(property: Node | undefined): Node | undefined {
  if (Node.isPropertyAssignment(property)) return property.getInitializer();
  if (Node.isShorthandPropertyAssignment(property)) return property;
  return Node.isMethodDeclaration(property) ? property : undefined;
}

/** The plugin function register() receives, through fastify-plugin and imports. */
export function pluginTarget(
  index: ProjectIndex,
  node: Node | undefined,
  depth = 0,
): PluginTarget | null {
  if (!node || depth > MAX_RESOLUTION_DEPTH) return null;
  const value = definition(index, node);
  if (isFunctionLike(value)) return { fn: value, encapsulated: true };
  if (Node.isVariableDeclaration(value)) {
    return pluginTarget(index, value.getInitializer(), depth + 1);
  }
  if (!Node.isCallExpression(value)) return null;
  const [first] = value.getArguments();
  if (moduleOf(value.getExpression()) === "fastify-plugin") {
    const inner = pluginTarget(index, first, depth + 1);
    return inner && { fn: inner.fn, encapsulated: false };
  }
  // register(import("./routes.js")) and register(require("./routes"))
  const specifier =
    value.getExpression().getKind() === SyntaxKind.ImportKeyword
      ? literalText(first)
      : requiredModule(value);
  const target =
    specifier === null
      ? undefined
      : resolveImport(index, value.getSourceFile(), specifier);
  return target
    ? pluginTarget(index, exportedValue(target, "default"), depth + 1)
    : null;
}

/**
 * The context a receiver belongs to. Instances resolved from Fastify(),
 * FastifyInstance types, or plugin parameters are high confidence; receivers
 * named like an instance (`app`, `this.server`) fall back to low confidence.
 */
export function instanceOf(
  index: ProjectIndex,
  receiver: Node,
  depth = 0,
): Instance | null {
  const value = chainRoot(receiver);
  const resolved =
    depth > MAX_RESOLUTION_DEPTH ? undefined : definition(index, value);
  if (Node.isVariableDeclaration(resolved)) {
    const root = index.roots.get(resolved);
    if (root) return { context: root, confidence: "high" };
    const initializer = resolved.getInitializer();
    // const server = fastify.withTypeProvider<ZodTypeProvider>()
    const alias = initializer && instanceOf(index, initializer, depth + 1);
    if (alias && alias.confidence === "high") return alias;
    if (HTTP_CLIENT.test(initializer?.getText() ?? "")) return null;
  }
  if (Node.isParameterDeclaration(resolved)) {
    const fn = resolved.getParent();
    const plugin = index.plugins.get(fn);
    if (plugin && isFunctionLike(fn) && fn.getParameters()[0] === resolved) {
      return { context: plugin, confidence: "high" };
    }
  }
  const text = value.getText();
  return INSTANCE_NAMES.test(text)
    ? {
        context: `${index.paths.get(value.getSourceFile())}#${text}`,
        confidence: "low",
      }
    : null;
}

/** Variables holding an instance from Fastify() or typed FastifyInstance. */
function collectRoots(
  sourceFile: SourceFile,
  file: string,
  roots: Map<Node, string>,
): void {
  for (const declaration of sourceFile.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    const initializer = declaration.getInitializer();
    const created =
      initializer && chainRoot(initializer).asKind(SyntaxKind.CallExpression);
    if (
      INSTANCE_TYPE.test(declaration.getTypeNode()?.getText() ?? "") ||
      (created && moduleOf(created.getExpression()) === "fastify")
    ) {
      roots.set(declaration, `${file}:${declaration.getStart()}`);
    }
  }
}

/** Functions that are plugins by their type or by a fastify-plugin wrapper. */
function declaredPlugins(
  index: ProjectIndex,
  sourceFile: SourceFile,
): PluginTarget[] {
  const found: Array<PluginTarget | null> = [];
  for (const parameter of sourceFile.getDescendantsOfKind(
    SyntaxKind.Parameter,
  )) {
    const fn = parameter.getParent();
    if (
      isFunctionLike(fn) &&
      fn.getParameters()[0] === parameter &&
      INSTANCE_TYPE.test(parameter.getTypeNode()?.getText() ?? "")
    ) {
      found.push({ fn, encapsulated: true });
    }
  }
  for (const typed of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.SatisfiesExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression),
  ]) {
    if (PLUGIN_TYPE.test(typed.getTypeNode()?.getText() ?? "")) {
      found.push(
        pluginTarget(
          index,
          Node.isVariableDeclaration(typed)
            ? typed.getInitializer()
            : typed.getExpression(),
        ),
      );
    }
  }
  if (sourceFile.getFullText().includes("fastify-plugin")) {
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (moduleOf(call.getExpression()) === "fastify-plugin") {
        found.push(pluginTarget(index, call));
      }
    }
  }
  return found.filter((target) => target !== null);
}

/**
 * Indexes instances and plugins: typed `(fastify: FastifyInstance)` and
 * FastifyPlugin* functions, fastify-plugin arguments, and anything an
 * instance registers. Registration repeats until no new plugin is found,
 * because a plugin's parameter is only an instance once the plugin is known.
 */
export function createProjectIndex(
  sources: ReadonlyArray<{ file: string; sourceFile: SourceFile }>,
): ProjectIndex {
  const roots = new Map<Node, string>();
  const plugins = new Map<Node, string>();
  const index: ProjectIndex = {
    paths: new Map(sources.map(({ file, sourceFile }) => [sourceFile, file])),
    files: new Map(sources.map(({ file, sourceFile }) => [file, sourceFile])),
    roots,
    plugins,
  };
  const add = (target: PluginTarget | null): boolean => {
    if (!target || plugins.has(target.fn)) return false;
    const file = index.paths.get(target.fn.getSourceFile());
    plugins.set(target.fn, `${file}:${target.fn.getStart()}`);
    return true;
  };

  for (const { file, sourceFile } of sources) {
    collectRoots(sourceFile, file, roots);
  }
  for (const { sourceFile } of sources) {
    for (const target of declaredPlugins(index, sourceFile)) add(target);
  }

  const registers = sources.flatMap(({ sourceFile }) =>
    sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => methodName(call) === "register"),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of registers) {
      if (
        instanceOf(index, receiverOf(call)) &&
        add(pluginTarget(index, call.getArguments()[0]))
      ) {
        changed = true;
      }
    }
  }
  return index;
}
