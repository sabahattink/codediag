import { posix } from "path";
import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type Project,
  type SourceFile,
} from "ts-morph";

/**
 * Minimal, syntax-only symbol resolution (no type checker): follows local
 * declarations, ES imports/exports and CommonJS require/module.exports across
 * relative modules. Anything else resolves to undefined.
 */

export type FunctionLike = ArrowFunction | FunctionExpression | FunctionDeclaration | MethodDeclaration;

/** What a name resolves to: a declaration/expression node, or a whole module (namespace import, require). */
export type Resolved = { kind: "node"; node: Node } | { kind: "module"; file: SourceFile };

const MAX_DEPTH = 8;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return node !== undefined && (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node));
}

/** `require("x")` → "x" */
export function requireSpecifier(node: Node | undefined): string | undefined {
  if (!node || !Node.isCallExpression(node)) return undefined;
  if (node.getExpression().getText() !== "require") return undefined;
  const arg = node.getArguments()[0];
  return arg && Node.isStringLiteral(arg) ? arg.getLiteralText() : undefined;
}

/** Resolves a relative module specifier to a source file, loading it from disk when needed. */
export function resolveModule(project: Project, from: SourceFile, specifier: string): SourceFile | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.join(posix.dirname(from.getFilePath()), specifier);
  const withoutJsExt = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => withoutJsExt + ext),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  for (const candidate of candidates) {
    const file = project.getSourceFile(candidate) ?? safeAdd(project, candidate);
    if (file) return file;
  }
  return undefined;
}

function safeAdd(project: Project, path: string): SourceFile | undefined {
  try {
    return project.addSourceFileAtPathIfExists(path);
  } catch {
    return undefined;
  }
}

/** Value of `module.exports = <expr>` or `export default <expr>` / `export default function`. */
function defaultExport(project: Project, file: SourceFile, depth: number): Resolved | undefined {
  for (const assignment of file.getExportAssignments()) {
    if (!assignment.isExportEquals() || file.getExportAssignments().length === 1) {
      return resolveExpression(project, file, assignment.getExpression(), depth + 1);
    }
  }
  const declared = [...file.getFunctions(), ...file.getClasses()].find((d) => d.hasDefaultKeyword());
  if (declared) return { kind: "node", node: declared };

  for (const statement of file.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    const expr = statement.getExpression();
    if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken && expr.getLeft().getText() === "module.exports") {
      return resolveExpression(project, file, expr.getRight(), depth + 1);
    }
  }
  return undefined;
}

/** Value exported under `name` (ES named export or CommonJS exports.name / module.exports = { name }). */
export function namedExport(project: Project, file: SourceFile, name: string, depth = 0): Resolved | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (name === "default") return defaultExport(project, file, depth);

  const fn = file.getFunction(name);
  if (fn?.hasExportKeyword()) return { kind: "node", node: fn };
  const variable = file.getVariableDeclaration(name);
  if (variable?.getVariableStatement()?.hasExportKeyword()) return { kind: "node", node: variable };

  for (const decl of file.getExportDeclarations()) {
    for (const spec of decl.getNamedExports()) {
      const exported = spec.getAliasNode()?.getText() ?? spec.getName();
      if (exported !== name) continue;
      const moduleSpecifier = decl.getModuleSpecifierValue();
      if (moduleSpecifier === undefined) return resolveName(project, file, spec.getName(), depth + 1);
      const target = resolveModule(project, file, moduleSpecifier);
      return target ? namedExport(project, target, spec.getName(), depth + 1) : undefined;
    }
  }

  for (const statement of file.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    const expr = statement.getExpression();
    if (!Node.isBinaryExpression(expr) || expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = expr.getLeft().getText();
    if (left === `exports.${name}` || left === `module.exports.${name}`) {
      return resolveExpression(project, file, expr.getRight(), depth + 1);
    }
    if (left === "module.exports" && Node.isObjectLiteralExpression(expr.getRight())) {
      return objectProperty(project, file, expr.getRight(), name, depth + 1);
    }
  }
  return undefined;
}

function objectProperty(project: Project, file: SourceFile, objectNode: Node, name: string, depth: number): Resolved | undefined {
  if (!Node.isObjectLiteralExpression(objectNode)) return undefined;
  const prop = objectNode.getProperty(name);
  if (!prop) return undefined;
  if (Node.isMethodDeclaration(prop)) return { kind: "node", node: prop };
  if (Node.isShorthandPropertyAssignment(prop)) return resolveName(project, file, name, depth + 1);
  if (Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    return init ? resolveExpression(project, file, init, depth + 1) : undefined;
  }
  return undefined;
}

/** Resolves an expression: identifiers and `require()` are followed, anything else is returned as-is. */
export function resolveExpression(project: Project, file: SourceFile, expr: Node, depth = 0): Resolved | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr)) {
    return resolveExpression(project, file, expr.getExpression(), depth + 1);
  }
  if (Node.isIdentifier(expr)) return resolveIdentifierNode(project, expr, depth + 1);

  const spec = requireSpecifier(expr);
  if (spec !== undefined) {
    const target = resolveModule(project, file, spec);
    if (!target) return undefined;
    return defaultExport(project, target, depth + 1) ?? { kind: "module", file: target };
  }

  if (Node.isPropertyAccessExpression(expr)) {
    const owner = resolveExpression(project, file, expr.getExpression(), depth + 1);
    if (!owner) return undefined;
    if (owner.kind === "module") return namedExport(project, owner.file, expr.getName(), depth + 1);
    if (Node.isVariableDeclaration(owner.node)) {
      const init = owner.node.getInitializer();
      return init ? objectProperty(project, owner.node.getSourceFile(), init, expr.getName(), depth + 1) : undefined;
    }
    return objectProperty(project, owner.node.getSourceFile(), owner.node, expr.getName(), depth + 1);
  }
  return { kind: "node", node: expr };
}

/** Resolves an identifier, checking enclosing function parameters before module scope. */
export function resolveIdentifierNode(project: Project, identifier: Node, depth = 0): Resolved | undefined {
  const name = identifier.getText();
  for (const ancestor of identifier.getAncestors()) {
    if (isFunctionLike(ancestor)) {
      const param = ancestor.getParameters().find((p) => p.getName() === name);
      if (param) return { kind: "node", node: param };
    }
  }
  return resolveName(project, identifier.getSourceFile(), name, depth);
}

/** Resolves a name declared or imported anywhere in `file`. */
export function resolveName(project: Project, file: SourceFile, name: string, depth = 0): Resolved | undefined {
  if (depth > MAX_DEPTH) return undefined;

  for (const imp of file.getImportDeclarations()) {
    const target = (): SourceFile | undefined => resolveModule(project, file, imp.getModuleSpecifierValue());
    if (imp.getDefaultImport()?.getText() === name) {
      const mod = target();
      return mod ? namedExport(project, mod, "default", depth + 1) : undefined;
    }
    if (imp.getNamespaceImport()?.getText() === name) {
      const mod = target();
      return mod ? { kind: "module", file: mod } : undefined;
    }
    const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
    if (named) {
      const mod = target();
      return mod ? namedExport(project, mod, named.getName(), depth + 1) : undefined;
    }
  }

  const fn = file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).find((f) => f.getName() === name);
  if (fn) return { kind: "node", node: fn };

  for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = decl.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      if (nameNode.getText() !== name) continue;
      const spec = requireSpecifier(decl.getInitializer());
      if (spec !== undefined) return resolveExpression(project, file, decl.getInitializerOrThrow(), depth + 1);
      return { kind: "node", node: decl };
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      const element = nameNode.getElements().find((e) => e.getName() === name);
      const spec = requireSpecifier(decl.getInitializer());
      if (!element || spec === undefined) continue;
      const mod = resolveModule(project, file, spec);
      const exported = element.getPropertyNameNode()?.getText() ?? name;
      return mod ? namedExport(project, mod, exported, depth + 1) : undefined;
    }
  }
  return undefined;
}

export interface ResolvedHandler {
  fn: FunctionLike;
  /** The handler is passed through a wrapper call such as asyncHandler(fn) or withAuth(fn). */
  wrapped: boolean;
  /** Text of the wrapper callee(s), e.g. "withAuth". */
  wrapperText: string;
}

/** Resolves a handler expression (inline function, identifier, obj.method, wrapper(fn)) to a function. */
export function resolveHandler(project: Project, file: SourceFile, expr: Node, depth = 0): ResolvedHandler | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (isFunctionLike(expr)) return { fn: expr, wrapped: false, wrapperText: "" };

  if (Node.isCallExpression(expr) && requireSpecifier(expr) === undefined) {
    return resolveWrapped(project, file, expr, depth);
  }

  const resolved = resolveExpression(project, file, expr, depth + 1);
  if (!resolved || resolved.kind !== "node") return undefined;
  const node = resolved.node;
  if (isFunctionLike(node)) return { fn: node, wrapped: false, wrapperText: "" };
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (!init) return undefined;
    if (isFunctionLike(init)) return { fn: init, wrapped: false, wrapperText: "" };
    if (Node.isCallExpression(init)) return resolveWrapped(project, node.getSourceFile(), init, depth + 1);
    return undefined;
  }
  if (Node.isCallExpression(node)) return resolveWrapped(project, node.getSourceFile(), node, depth + 1);
  return undefined;
}

function resolveWrapped(project: Project, file: SourceFile, call: CallExpression, depth: number): ResolvedHandler | undefined {
  const callee = call.getExpression().getText();
  for (const arg of call.getArguments()) {
    const inner = resolveHandler(project, file, arg, depth + 1);
    if (inner) return { fn: inner.fn, wrapped: true, wrapperText: [callee, inner.wrapperText].filter(Boolean).join(" ") };
  }
  return undefined;
}

/** Whether the function reads `<firstParam>.body` (or destructures `body` from it). */
export function readsRequestBody(fn: FunctionLike, accessors: RegExp = /\.body\b/): boolean {
  const first = fn.getParameters()[0];
  if (!first) return false;
  const nameNode = first.getNameNode();
  if (Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().some((e) => (e.getPropertyNameNode()?.getText() ?? e.getName()) === "body");
  }
  const param = nameNode.getText().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${param}(?:${accessors.source}|\\[['"]body['"]\\])`);
  return pattern.test(fn.getText());
}

/** try/catch or a promise .catch() inside the function. */
export function hasErrorHandling(fn: FunctionLike): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0 || /\.catch\s*\(/.test(fn.getText());
}
