import {
  type CallExpression,
  type Expression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";

const SOURCE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

const RUNTIME_IGNORES = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const COMMAND_FUNCTIONS = new Set(["exec", "execSync"]);
const SQL_METHODS = new Set([
  "$executeRawUnsafe",
  "$queryRawUnsafe",
  "execute",
  "query",
  "raw",
]);
const SQL_RECEIVER =
  /(?:^|\.)(?:client|connection|database|db|entityManager|knex|pool|prisma|queryRunner|sql)$/i;
const REQUEST_DATA =
  /\b(?:req(?:uest)?|ctx)\s*(?:\.|\[)|\bprocess\s*\.\s*argv\b|\b(?:body|params|query)\s*(?:\.|\[)|\bsearchParams\b/i;
const SQL_KEYWORDS =
  /\b(?:select|insert\s+into|update|delete\s+from|from|where|values|join)\b/i;
/** How many variable assignments taint tracking follows back from a sink. */
const MAX_TAINT_HOPS = 3;

interface CommandBindings {
  functions: Set<string>;
  namespaces: Set<string>;
}

function sourceLocation(file: string, line: number) {
  return { file, line };
}

function isModuleCall(expression: Expression, modules: Set<string>): boolean {
  if (!Node.isCallExpression(expression)) return false;
  if (expression.getExpression().getText() !== "require") return false;
  const moduleArgument = expression.getArguments()[0];
  return (
    Node.isStringLiteral(moduleArgument) &&
    modules.has(moduleArgument.getLiteralText())
  );
}

function commandBindings(sourceFile: SourceFile): CommandBindings {
  const functions = new Set<string>();
  const namespaces = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!CHILD_PROCESS_MODULES.has(declaration.getModuleSpecifierValue())) {
      continue;
    }

    const namespace = declaration.getNamespaceImport();
    if (namespace) namespaces.add(namespace.getText());

    for (const namedImport of declaration.getNamedImports()) {
      if (!COMMAND_FUNCTIONS.has(namedImport.getName())) continue;
      functions.add(
        namedImport.getAliasNode()?.getText() ?? namedImport.getName(),
      );
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !isModuleCall(initializer, CHILD_PROCESS_MODULES)) {
      continue;
    }

    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      namespaces.add(nameNode.getText());
      continue;
    }
    if (!Node.isObjectBindingPattern(nameNode)) continue;

    for (const element of nameNode.getElements()) {
      const importedName =
        element.getPropertyNameNode()?.getText() ?? element.getName();
      if (COMMAND_FUNCTIONS.has(importedName)) functions.add(element.getName());
    }
  }

  return { functions, namespaces };
}

function commandCall(call: CallExpression, bindings: CommandBindings): boolean {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) {
    return bindings.functions.has(expression.getText());
  }
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (
    bindings.namespaces.has(expression.getExpression().getText()) &&
    COMMAND_FUNCTIONS.has(expression.getName())
  ) {
    return true;
  }
  return (
    COMMAND_FUNCTIONS.has(expression.getName()) &&
    isModuleCall(expression.getExpression(), CHILD_PROCESS_MODULES)
  );
}

function isStaticString(node: Node | undefined): boolean {
  return Boolean(
    node &&
      (Node.isStringLiteral(node) ||
        Node.isNoSubstitutionTemplateLiteral(node)),
  );
}

type ScopeNode = Node;

function enclosingScope(node: Node): ScopeNode {
  return (
    node.getFirstAncestor(
      (ancestor) =>
        Node.isFunctionDeclaration(ancestor) ||
        Node.isFunctionExpression(ancestor) ||
        Node.isArrowFunction(ancestor) ||
        Node.isMethodDeclaration(ancestor) ||
        Node.isConstructorDeclaration(ancestor),
    ) ?? node.getSourceFile()
  );
}

function boundNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return name
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((element) => Node.isBindingElement(element.getParent()))
      .map((element) => element.getText());
  }
  return [];
}

interface ScopeIndex {
  /** Initializers of variables declared directly in this scope. */
  declarations: Map<string, Node[]>;
  /** Right-hand sides of plain `name = value` assignments in this scope. */
  assignments: Map<string, Node[]>;
}

const scopeIndexes = new WeakMap<Node, ScopeIndex>();

function add(map: Map<string, Node[]>, name: string, node: Node): void {
  const list = map.get(name);
  if (list) list.push(node);
  else map.set(name, [node]);
}

/** Indexes a scope once, so taint lookups do not rescan it per identifier. */
function indexScope(scope: ScopeNode): ScopeIndex {
  const existing = scopeIndexes.get(scope);
  if (existing) return existing;

  const index: ScopeIndex = { declarations: new Map(), assignments: new Map() };
  for (const declaration of scope.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    if (enclosingScope(declaration) !== scope) continue;
    for (const name of boundNames(declaration.getNameNode())) {
      // Destructuring propagates the whole initializer to every bound name.
      const initializer = declaration.getInitializer();
      if (initializer) add(index.declarations, name, initializer);
      else if (!index.declarations.has(name)) index.declarations.set(name, []);
    }
  }
  for (const binary of scope.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (
      binary.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      Node.isIdentifier(binary.getLeft())
    ) {
      add(index.assignments, binary.getLeft().getText(), binary.getRight());
    }
  }
  scopeIndexes.set(scope, index);
  return index;
}

/**
 * The expressions a variable can hold: initializers of its declaration in the
 * nearest scope that declares it, and plain reassignments in that scope.
 */
function valueSources(identifier: Node): Node[] {
  const name = identifier.getText();
  let scope: ScopeNode | undefined = enclosingScope(identifier);
  while (scope) {
    const index = indexScope(scope);
    const declared = index.declarations.get(name);
    if (declared) return [...declared, ...(index.assignments.get(name) ?? [])];
    scope = Node.isSourceFile(scope) ? undefined : enclosingScope(scope);
  }
  return [];
}

function isPropertyName(identifier: Node): boolean {
  const parent = identifier.getParent();
  return Boolean(
    parent &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === identifier,
  );
}

/**
 * True when an expression visibly contains request data, directly or through
 * up to MAX_TAINT_HOPS variable assignments in enclosing scopes.
 */
const taintCache = new WeakMap<Node, boolean>();

function isTainted(node: Node, hops = 0, seen = new Set<Node>()): boolean {
  if (hops === 0) {
    const cached = taintCache.get(node);
    if (cached !== undefined) return cached;
    const tainted = traceTaint(node, 0, seen);
    taintCache.set(node, tainted);
    return tainted;
  }
  return traceTaint(node, hops, seen);
}

function traceTaint(node: Node, hops: number, seen: Set<Node>): boolean {
  if (REQUEST_DATA.test(node.getText())) return true;
  if (hops >= MAX_TAINT_HOPS) return false;

  const identifiers = Node.isIdentifier(node)
    ? [node]
    : node.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const identifier of identifiers) {
    if (isPropertyName(identifier)) continue;
    for (const source of valueSources(identifier)) {
      if (seen.has(source)) continue;
      seen.add(source);
      if (isTainted(source, hops + 1, seen)) return true;
    }
  }
  return false;
}

/** A template with substitutions or a `+` concatenation, seen through variables. */
function dynamicStringShape(node: Node, hops = 0): Node | null {
  if (Node.isTemplateExpression(node)) return node;
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    return node;
  }
  if (Node.isIdentifier(node) && hops < MAX_TAINT_HOPS) {
    for (const source of valueSources(node)) {
      const shape = dynamicStringShape(source, hops + 1);
      if (shape) return shape;
    }
  }
  return null;
}

function isDynamicSqlCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (!SQL_METHODS.has(expression.getName())) return false;

  const query = call.getArguments()[0];
  if (!query || isStaticString(query)) return false;
  if (
    expression.getName().endsWith("Unsafe") ||
    SQL_RECEIVER.test(expression.getExpression().getText())
  ) {
    return true;
  }

  // Any receiver: a query string built from request data is SQL injection.
  const shape = dynamicStringShape(query);
  return Boolean(
    shape && SQL_KEYWORDS.test(shape.getText()) && isTainted(query),
  );
}

function severityForDynamicInput(
  node: Node | undefined,
): DiagnosticIssue["severity"] {
  return node && isTainted(node) ? "critical" : "warning";
}

function inspectSourceFile(
  sourceFile: SourceFile,
  file: string,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const bindings = commandBindings(sourceFile);

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    const isEval =
      (Node.isIdentifier(expression) && expression.getText() === "eval") ||
      (Node.isPropertyAccessExpression(expression) &&
        expression.getExpression().getText() === "globalThis" &&
        expression.getName() === "eval");

    if (isEval) {
      issues.push({
        ...fromRule("unsafe-dynamic-code"),
        message: "Runtime code execution uses eval()",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Replace eval() with explicit parsing, dispatch, or a sandbox designed for untrusted code",
      });
      continue;
    }

    if (commandCall(call, bindings)) {
      const command = call.getArguments()[0];
      if (command && !isStaticString(command)) {
        issues.push({
          ...fromRule("dynamic-command-execution"),
          severity: severityForDynamicInput(command),
          message: "Shell execution receives a non-literal command",
          ...sourceLocation(file, call.getStartLineNumber()),
          fix: "Avoid a shell; use execFile or spawn with a fixed executable and validated argument array",
        });
      }
    }

    if (isDynamicSqlCall(call)) {
      const query = call.getArguments()[0];
      issues.push({
        ...fromRule("dynamic-sql-query"),
        severity: severityForDynamicInput(query),
        message: "SQL execution uses a dynamically constructed query",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Use parameterized queries or the ORM's safe tagged-template API",
      });
    }
  }

  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    const constructorName = expression.getExpression().getText();
    if (
      constructorName !== "Function" &&
      constructorName !== "globalThis.Function"
    ) {
      continue;
    }
    issues.push({
      ...fromRule("unsafe-dynamic-code"),
      message: "Runtime code execution uses the Function constructor",
      ...sourceLocation(file, expression.getStartLineNumber()),
      fix: "Replace generated code with explicit parsing or a sandbox designed for untrusted code",
    });
  }

  for (const property of sourceFile.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    const name = property.getName().replace(/["']/g, "");
    const initializer = property.getInitializer();
    const disablesTls =
      (name === "rejectUnauthorized" &&
        initializer?.getKind() === SyntaxKind.FalseKeyword) ||
      (name === "NODE_TLS_REJECT_UNAUTHORIZED" &&
        Node.isStringLiteral(initializer) &&
        initializer.getLiteralText() === "0");
    if (!disablesTls) continue;

    issues.push({
      ...fromRule("tls-verification-disabled"),
      message: "TLS certificate verification is disabled",
      ...sourceLocation(file, property.getStartLineNumber()),
      fix: "Enable certificate verification and configure a trusted CA when a private PKI is required",
    });
  }

  for (const assignment of sourceFile.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (
      assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken ||
      assignment.getLeft().getText() !==
        "process.env.NODE_TLS_REJECT_UNAUTHORIZED"
    ) {
      continue;
    }
    const value = assignment.getRight();
    if (!Node.isStringLiteral(value) || value.getLiteralText() !== "0") {
      continue;
    }

    issues.push({
      ...fromRule("tls-verification-disabled"),
      message: "TLS certificate verification is disabled globally",
      ...sourceLocation(file, assignment.getStartLineNumber()),
      fix: "Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and configure a trusted CA instead",
    });
  }

  return issues;
}

export async function analyzeSecuritySinks(
  context: ScanContext,
): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: RUNTIME_IGNORES,
  })) {
    const sourceFile = context.getSourceFile(file);
    if (!sourceFile) continue;
    try {
      issues.push(...inspectSourceFile(sourceFile, file));
    } catch {
      // A malformed source file should not stop the scan.
    }
  }

  return issues;
}
