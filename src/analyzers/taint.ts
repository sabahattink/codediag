import {
  type CallExpression,
  type Decorator,
  type Expression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

/**
 * Request-data taint tracking shared by the security sink rules: which local
 * names a module's functions are bound to, which expressions a variable can
 * hold, and whether a value comes from the request.
 */

export const SOURCE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

export const RUNTIME_IGNORES = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

export const REQUEST_DATA =
  /\b(?:req(?:uest)?|ctx)\s*(?:\.|\[)|\bprocess\s*\.\s*argv\b|\b(?:body|params|query)\s*(?:\.|\[)|\bsearchParams\b/i;

/** How many variable assignments taint tracking follows back from a sink. */
export const MAX_TAINT_HOPS = 3;

/**
 * Steps across function boundaries. Without them, taint tracking stays within
 * a function and its enclosing scopes; taint-calls.ts implements them.
 */
export interface CallSteps {
  /**
   * True when a parameter reference holds request data because callers pass
   * it: strictly (`isRequestValue`) or visibly (`isTainted`).
   */
  parameter(identifier: Node, strict: boolean): boolean;
  /** True when a call to a project function returns request data. */
  result(call: CallExpression): boolean;
  /**
   * True when `this.name` holds request data that a member of its class
   * stored there, or that a `new` expression passed to its constructor.
   */
  member(access: PropertyAccessExpression, strict: boolean): boolean;
}

/** The request-data checks a sink rule uses, with or without call steps. */
export interface Taint {
  isRequestValue(node: Node): boolean;
  isTainted(node: Node): boolean;
  /**
   * For a value that is exactly a parameter of a project function or a
   * field of `this`: whether `check` holds for the argument some caller
   * passes in its place, or for a value stored in the field. Undefined when
   * the value is neither or tracking stays local.
   */
  throughCallers(
    value: Node,
    check: (argument: Node) => boolean,
  ): boolean | undefined;
}

/** Taint tracking within a function and its enclosing scopes. */
export const LOCAL_TAINT: Taint = {
  isRequestValue: (node) => isRequestValue(node),
  isTainted: (node) => isTainted(node),
  throughCallers: () => undefined,
};

export function isModuleCall(
  expression: Expression,
  modules: Set<string>,
): boolean {
  if (!Node.isCallExpression(expression)) return false;
  if (expression.getExpression().getText() !== "require") return false;
  const moduleArgument = expression.getArguments()[0];
  return (
    Node.isStringLiteral(moduleArgument) &&
    modules.has(moduleArgument.getLiteralText())
  );
}

export interface ModuleBindings {
  /** Local names bound to the module's sink functions. */
  functions: Set<string>;
  /** Local names bound to the whole module (or its `promises` API). */
  namespaces: Set<string>;
}

export function moduleBindings(
  sourceFile: SourceFile,
  modules: Set<string>,
  sinkFunctions: Set<string>,
): ModuleBindings {
  const functions = new Set<string>();
  const namespaces = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!modules.has(declaration.getModuleSpecifierValue())) continue;

    const namespace = declaration.getNamespaceImport();
    if (namespace) namespaces.add(namespace.getText());
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) namespaces.add(defaultImport.getText());

    for (const namedImport of declaration.getNamedImports()) {
      const local =
        namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      if (sinkFunctions.has(namedImport.getName())) functions.add(local);
      if (namedImport.getName() === "promises") namespaces.add(local);
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !isModuleCall(initializer, modules)) continue;

    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      namespaces.add(nameNode.getText());
      continue;
    }
    if (!Node.isObjectBindingPattern(nameNode)) continue;

    for (const element of nameNode.getElements()) {
      const importedName =
        element.getPropertyNameNode()?.getText() ?? element.getName();
      if (sinkFunctions.has(importedName)) functions.add(element.getName());
      if (importedName === "promises") namespaces.add(element.getName());
    }
  }

  return { functions, namespaces };
}

export function moduleCall(
  call: CallExpression,
  bindings: ModuleBindings,
  modules: Set<string>,
  sinkFunctions: Set<string>,
): boolean {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) {
    return bindings.functions.has(expression.getText());
  }
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (!sinkFunctions.has(expression.getName())) return false;

  const receiver = expression.getExpression();
  const namespace = receiver.getText().replace(/\.promises$/, "");
  return (
    bindings.namespaces.has(namespace) ||
    isModuleCall(receiver, modules) ||
    (Node.isPropertyAccessExpression(receiver) &&
      receiver.getName() === "promises" &&
      isModuleCall(receiver.getExpression(), modules))
  );
}

export function isStaticString(node: Node | undefined): boolean {
  return Boolean(
    node &&
      (Node.isStringLiteral(node) ||
        Node.isNoSubstitutionTemplateLiteral(node)),
  );
}

type ScopeNode = Node;

export function enclosingScope(node: Node): ScopeNode {
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

export function add<T>(map: Map<string, T[]>, name: string, value: T): void {
  const list = map.get(name);
  if (list) list.push(value);
  else map.set(name, [value]);
}

/** Array methods whose callback receives an element first: `forEach(item)`. */
const ELEMENT_CALLBACKS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);
/** Array methods whose callback receives an element second: `reduce(sum, item)`. */
const REDUCE_CALLBACKS = new Set(["reduce", "reduceRight"]);

/**
 * For a callback written inline as the first argument of an array method or
 * `then()`: its parameter that receives the receiver's elements or resolved
 * value, and that receiver. An element of request data is request data.
 */
function callbackElement(
  scope: ScopeNode,
): { parameter: Node; receiver: Node } | undefined {
  if (!Node.isArrowFunction(scope) && !Node.isFunctionExpression(scope)) {
    return undefined;
  }
  const call = scope.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== scope) {
    return undefined;
  }
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.getName();
  const position =
    ELEMENT_CALLBACKS.has(method) || method === "then"
      ? 0
      : REDUCE_CALLBACKS.has(method)
        ? 1
        : undefined;
  if (position === undefined) return undefined;
  const parameter = scope
    .getParameters()
    .filter((candidate) => candidate.getName() !== "this")[position];
  return parameter
    ? { parameter: parameter.getNameNode(), receiver: callee.getExpression() }
    : undefined;
}

/** `items` for the variable of `for (const item of items)`. */
function iteratedValue(declaration: VariableDeclaration): Node | undefined {
  const statement = declaration.getParent()?.getParent();
  return Node.isForOfStatement(statement)
    ? statement.getExpression()
    : undefined;
}

/** Indexes a scope once, so taint lookups do not rescan it per identifier. */
function indexScope(scope: ScopeNode): ScopeIndex {
  const existing = scopeIndexes.get(scope);
  if (existing) return existing;

  const index: ScopeIndex = { declarations: new Map(), assignments: new Map() };
  const element = callbackElement(scope);
  if (element) {
    for (const name of boundNames(element.parameter)) {
      add(index.declarations, name, element.receiver);
    }
  }
  for (const declaration of scope.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    if (enclosingScope(declaration) !== scope) continue;
    for (const name of boundNames(declaration.getNameNode())) {
      // Destructuring propagates the whole initializer to every bound name,
      // and a for...of variable holds elements of the iterated value.
      const initializer =
        declaration.getInitializer() ?? iteratedValue(declaration);
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
export function valueSources(identifier: Node): Node[] {
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

function isCallee(identifier: Node): boolean {
  const parent = identifier.getParent();
  return Boolean(
    parent &&
      Node.isCallExpression(parent) &&
      parent.getExpression() === identifier,
  );
}

/**
 * True when an expression visibly contains request data, directly or through
 * up to MAX_TAINT_HOPS variable assignments in enclosing scopes. With call
 * steps, parameters are followed to their callers, project functions'
 * results to what they return, and fields of `this` to what is stored in
 * them.
 */
const taintCache = new WeakMap<Node, boolean>();

export function isTainted(node: Node, calls?: CallSteps): boolean {
  if (calls) return traceTaint(node, 0, new Set(), calls);
  const cached = taintCache.get(node);
  if (cached !== undefined) return cached;
  const tainted = traceTaint(node, 0, new Set());
  taintCache.set(node, tainted);
  return tainted;
}

function traceTaint(
  node: Node,
  hops: number,
  seen: Set<Node>,
  calls?: CallSteps,
): boolean {
  if (REQUEST_DATA.test(node.getText())) return true;
  if (calls && callReturnsRequestData(node, calls)) return true;
  if (hops >= MAX_TAINT_HOPS) return false;

  const identifiers = Node.isIdentifier(node)
    ? [node]
    : node.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const identifier of identifiers) {
    if (isPropertyName(identifier)) continue;
    for (const source of valueSources(identifier)) {
      if (seen.has(source)) continue;
      seen.add(source);
      if (traceTaint(source, hops + 1, seen, calls)) return true;
    }
    if (calls && !isCallee(identifier) && calls.parameter(identifier, false)) {
      return true;
    }
  }
  return calls
    ? thisMembers(node).some((access) => calls.member(access, false))
    : false;
}

/** The `this.name` fields a node reads, without method calls `this.run()`. */
function thisMembers(node: Node): PropertyAccessExpression[] {
  const accesses = node.getDescendantsOfKind(
    SyntaxKind.PropertyAccessExpression,
  );
  if (Node.isPropertyAccessExpression(node)) accesses.unshift(node);
  return accesses.filter(
    (access) =>
      Node.isThisExpression(access.getExpression()) && !isCallee(access),
  );
}

/** True when the node is, or contains, a call whose result is request data. */
function callReturnsRequestData(node: Node, calls: CallSteps): boolean {
  const expressions = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  if (Node.isCallExpression(node)) expressions.unshift(node);
  return expressions.some((call) => calls.result(call));
}

/** A template with substitutions or a `+` concatenation, seen through variables. */
export function dynamicStringShape(node: Node, hops = 0): Node | null {
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

/** Calls on a request value that return part of it: `query.get("x").trim()`. */
const REQUEST_VALUE_METHODS = new Set([
  "at",
  "formData",
  "get",
  "getAll",
  "json",
  "replace",
  "replaceAll",
  "slice",
  "substring",
  "text",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
]);
/** Functions whose result still carries a request value passed to them. */
const REQUEST_VALUE_FUNCTIONS = new Set([
  "String",
  "decodeURI",
  "decodeURIComponent",
  "join",
  "normalize",
  "resolve",
]);

/**
 * Request properties the server fills in rather than the client: upload temp
 * files (multer), the authenticated user, the session, and connection facts.
 */
const SERVER_SET_REQUEST_DATA =
  /\b(?:req(?:uest)?|ctx)\s*\.\s*(?:app|auth|file|files|ip|ips|method|protocol|secure|session|state|user)\b/;

export const REQUEST_OBJECT = /^(?:req|request|ctx)$/;
/** Express-style response objects, possibly behind chained calls. */
export const RESPONSE_OBJECT = /^(?:res|response|reply)$/;
/** NestJS parameter decorators that inject request data. */
const REQUEST_DECORATORS = new Set(["Body", "Headers", "Param", "Query"]);

/**
 * The NestJS decorator that injects a parameter from the request:
 * `@Query("q") q` (one field) or `@Body() dto` (the parsed object).
 */
export function requestDecorator(identifier: Node): Decorator | undefined {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isParameterDeclaration(declaration)) continue;
    const decorator = declaration
      .getDecorators()
      .find((candidate) => REQUEST_DECORATORS.has(candidate.getName()));
    if (decorator) return decorator;
  }
  return undefined;
}

export function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isAwaitExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * True when the expression evaluates to request data itself, not to the
 * result of an arbitrary function given request data. Unlike `isTainted`, a
 * lookup such as `db.find(req.params.id)` is not request data, and wrapping
 * the value in `basename()`, `escapeHtml()`, `Number()`, or
 * `encodeURIComponent()` ends the trace, because those calls are not
 * pass-throughs. With call steps, a parameter is request data when a caller
 * passes request data for it, a project function's result is when the
 * function returns its request-data parameter or request data it reads, and
 * a field of `this` is when its class stores request data in it.
 */
export function isRequestValue(
  node: Node,
  hops = 0,
  calls?: CallSteps,
): boolean {
  const value = unwrap(node);

  if (Node.isIdentifier(value)) {
    if (requestDecorator(value)) return true;
    if (
      hops < MAX_TAINT_HOPS &&
      valueSources(value).some((source) =>
        isRequestValue(source, hops + 1, calls),
      )
    ) {
      return true;
    }
    return calls?.parameter(value, true) ?? false;
  }
  if (
    Node.isPropertyAccessExpression(value) ||
    Node.isElementAccessExpression(value)
  ) {
    const text = value.getText();
    if (SERVER_SET_REQUEST_DATA.test(text)) return false;
    if (REQUEST_DATA.test(text) && !hasCallInside(value)) return true;
    const receiver = value.getExpression();
    // `this.name`: request data a member of the class stored on the object.
    if (Node.isThisExpression(receiver)) {
      return (
        Node.isPropertyAccessExpression(value) &&
        (calls?.member(value, true) ?? false)
      );
    }
    return isRequestValue(receiver, hops, calls);
  }
  if (Node.isCallExpression(value)) {
    return (
      isRequestValueCall(value, hops, calls) || (calls?.result(value) ?? false)
    );
  }
  if (Node.isNewExpression(value)) {
    return (
      value.getExpression().getText() === "URL" &&
      isRequestValue(value.getArguments()[0] ?? value, hops, calls)
    );
  }
  if (Node.isConditionalExpression(value)) {
    return (
      isRequestValue(value.getWhenTrue(), hops, calls) ||
      isRequestValue(value.getWhenFalse(), hops, calls)
    );
  }
  if (
    Node.isTemplateExpression(value) ||
    (Node.isBinaryExpression(value) &&
      value.getOperatorToken().getKind() === SyntaxKind.PlusToken)
  ) {
    return stringParts(value).some(
      (part) => typeof part !== "string" && isRequestValue(part, hops, calls),
    );
  }
  return false;
}

/** Built-in calls that pass request data through: `query.get("x").trim()`. */
function isRequestValueCall(
  call: CallExpression,
  hops: number,
  calls: CallSteps | undefined,
): boolean {
  const callee = call.getExpression();
  if (
    Node.isPropertyAccessExpression(callee) &&
    REQUEST_VALUE_METHODS.has(callee.getName())
  ) {
    const receiver = unwrap(callee.getExpression());
    // `request.json()`, `req.get("host")`: a method of the request itself.
    if (
      Node.isIdentifier(receiver) &&
      REQUEST_OBJECT.test(receiver.getText())
    ) {
      return true;
    }
    return isRequestValue(receiver, hops, calls);
  }
  return (
    REQUEST_VALUE_FUNCTIONS.has(calleeName(call)) &&
    call
      .getArguments()
      .some((argument) => isRequestValue(argument, hops, calls))
  );
}

export function hasCallInside(node: Node): boolean {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0;
}

/** The called function's own name: `basename` for `path.basename(x)`. */
export function calleeName(call: CallExpression): string {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression)
    ? expression.getName()
    : expression.getText();
}

/**
 * A string's pieces from left to right: literal text, or the expression that
 * fills a slot. Single-assignment variables are followed.
 */
export function stringParts(node: Node, hops = 0): Array<string | Node> {
  const value = unwrap(node);
  if (
    Node.isStringLiteral(value) ||
    Node.isNoSubstitutionTemplateLiteral(value)
  ) {
    return [value.getLiteralText()];
  }
  if (Node.isTemplateExpression(value)) {
    const parts: Array<string | Node> = [value.getHead().getLiteralText()];
    for (const span of value.getTemplateSpans()) {
      parts.push(...stringParts(span.getExpression(), hops));
      parts.push(span.getLiteral().getLiteralText());
    }
    return parts;
  }
  if (
    Node.isBinaryExpression(value) &&
    value.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    return [
      ...stringParts(value.getLeft(), hops),
      ...stringParts(value.getRight(), hops),
    ];
  }
  if (Node.isIdentifier(value) && hops < MAX_TAINT_HOPS) {
    const sources = valueSources(value);
    if (sources.length === 1) return stringParts(sources[0], hops + 1);
  }
  return [value];
}

export function objectProperty(
  node: Node | undefined,
  names: string[],
): Node | null {
  if (!node || !Node.isObjectLiteralExpression(node)) return null;
  for (const name of names) {
    const property = node.getProperty(name);
    if (Node.isPropertyAssignment(property)) {
      return property.getInitializer() ?? null;
    }
    if (Node.isShorthandPropertyAssignment(property)) {
      return property.getNameNode();
    }
  }
  return null;
}
