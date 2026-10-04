import {
  type CallExpression,
  type Expression,
  Node,
  type PropertyAccessExpression,
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
const FS_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "fs-extra",
]);
/** File system functions whose first argument is a path to read or change. */
const FILE_FUNCTIONS = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createReadStream",
  "createWriteStream",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);
const HTTP_CLIENT_FUNCTIONS = new Set([
  "axios",
  "fetch",
  "got",
  "ky",
  "needle",
]);
const HTTP_CLIENT_RECEIVER =
  /(?:^|\.)(?:axios|got|ky|http|https|httpService|needle|superagent|undici)$/;
const HTTP_CLIENT_METHODS = new Set([
  "delete",
  "fetch",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "request",
  "stream",
]);
/** Express-style response objects, possibly behind chained calls. */
const RESPONSE_OBJECT = /^(?:res|response|reply)$/;
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

interface ModuleBindings {
  /** Local names bound to the module's sink functions. */
  functions: Set<string>;
  /** Local names bound to the whole module (or its `promises` API). */
  namespaces: Set<string>;
}

function moduleBindings(
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

function moduleCall(
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

const REQUEST_OBJECT = /^(?:req|request|ctx)$/;

function unwrap(node: Node): Node {
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
 * pass-throughs.
 */
function isRequestValue(node: Node, hops = 0): boolean {
  const value = unwrap(node);

  if (Node.isIdentifier(value)) {
    if (hops >= MAX_TAINT_HOPS) return false;
    return valueSources(value).some((source) =>
      isRequestValue(source, hops + 1),
    );
  }
  if (
    Node.isPropertyAccessExpression(value) ||
    Node.isElementAccessExpression(value)
  ) {
    const text = value.getText();
    if (SERVER_SET_REQUEST_DATA.test(text)) return false;
    if (REQUEST_DATA.test(text) && !hasCallInside(value)) return true;
    return isRequestValue(value.getExpression(), hops);
  }
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
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
      return isRequestValue(receiver, hops);
    }
    return (
      REQUEST_VALUE_FUNCTIONS.has(calleeName(value)) &&
      value.getArguments().some((argument) => isRequestValue(argument, hops))
    );
  }
  if (Node.isNewExpression(value)) {
    return (
      value.getExpression().getText() === "URL" &&
      isRequestValue(value.getArguments()[0] ?? value, hops)
    );
  }
  if (Node.isConditionalExpression(value)) {
    return (
      isRequestValue(value.getWhenTrue(), hops) ||
      isRequestValue(value.getWhenFalse(), hops)
    );
  }
  if (
    Node.isTemplateExpression(value) ||
    (Node.isBinaryExpression(value) &&
      value.getOperatorToken().getKind() === SyntaxKind.PlusToken)
  ) {
    return stringParts(value).some(
      (part) => typeof part !== "string" && isRequestValue(part, hops),
    );
  }
  return false;
}

function hasCallInside(node: Node): boolean {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0;
}

/** The called function's own name: `basename` for `path.basename(x)`. */
function calleeName(call: CallExpression): string {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression)
    ? expression.getName()
    : expression.getText();
}

/**
 * A string's pieces from left to right: literal text, or the expression that
 * fills a slot. Single-assignment variables are followed.
 */
function stringParts(node: Node, hops = 0): Array<string | Node> {
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

/**
 * Text that pins a URL's origin before its first request-controlled part:
 * `https://host/`, `${base}/`, or a same-site path such as `/account`. A
 * protocol-relative `//` start does not count.
 */
const FIXED_ORIGIN =
  /^(?:[a-z][a-z\d+.-]*:\/\/[^/?#\\]+[/?#]|[^:/?#\\]+[/?#]|\/[^/\\])/i;

/**
 * True when request data decides where a URL points: it is used before the
 * literal text fixes the scheme and host. Other expressions count as fixed.
 */
function requestControlsTarget(node: Node): boolean {
  let prefix = "";
  for (const part of stringParts(node)) {
    if (typeof part === "string") prefix += part;
    else if (isRequestValue(part)) return !FIXED_ORIGIN.test(prefix);
    else prefix += "X";
  }
  return false;
}

/** For `res.status(200).send(x)`: the final method and the calls before it. */
function responseCall(
  call: CallExpression,
): { method: string; chain: CallExpression[] } | null {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return null;
  const chain: CallExpression[] = [];
  let receiver: Node = expression.getExpression();
  while (
    Node.isCallExpression(receiver) &&
    Node.isPropertyAccessExpression(receiver.getExpression())
  ) {
    chain.push(receiver);
    receiver = (
      receiver.getExpression() as PropertyAccessExpression
    ).getExpression();
  }
  if (
    !Node.isIdentifier(receiver) ||
    !RESPONSE_OBJECT.test(receiver.getText())
  ) {
    return null;
  }
  return { method: expression.getName(), chain };
}

function objectProperty(node: Node | undefined, names: string[]): Node | null {
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

/** True when the enclosing function checks a variable with `startsWith()`. */
function isPrefixChecked(argument: Node): boolean {
  const scopeText = enclosingScope(argument).getText();
  const value = unwrap(argument);
  const identifiers = Node.isIdentifier(value)
    ? [value]
    : value.getDescendantsOfKind(SyntaxKind.Identifier);
  return identifiers.some((identifier) =>
    new RegExp(
      `\\b${identifier.getText().replace(/\$/g, "\\$")}\\s*\\.\\s*startsWith\\s*\\(`,
    ).test(scopeText),
  );
}

/** The file path a call reads or changes when request data chooses it. */
function traversalPath(
  call: CallExpression,
  files: ModuleBindings,
): Node | null {
  if (moduleCall(call, files, FS_MODULES, FILE_FUNCTIONS)) {
    const paths = call.getArguments().slice(0, 1);
    if (/^(?:copyFile|rename)/.test(calleeName(call))) {
      paths.push(...call.getArguments().slice(1, 2));
    }
    return (
      paths.find((path) => isRequestValue(path) && !isPrefixChecked(path)) ??
      null
    );
  }

  const response = responseCall(call);
  if (!response || !["download", "sendFile"].includes(response.method)) {
    return null;
  }
  const [path, ...options] = call.getArguments();
  // Express rejects `..` segments when a root directory is given.
  if (options.some((option) => objectProperty(option, ["root"]))) return null;
  return path && isRequestValue(path) && !isPrefixChecked(path) ? path : null;
}

/** The URL an outgoing HTTP request uses, when request data picks its host. */
function forgedRequestUrl(call: CallExpression): Node | null {
  const expression = call.getExpression();
  const isClient = Node.isIdentifier(expression)
    ? HTTP_CLIENT_FUNCTIONS.has(expression.getText())
    : Node.isPropertyAccessExpression(expression) &&
      HTTP_CLIENT_METHODS.has(expression.getName()) &&
      HTTP_CLIENT_RECEIVER.test(expression.getExpression().getText());
  if (!isClient) return null;

  const [first] = call.getArguments();
  const url =
    objectProperty(first, ["url", "baseURL", "host", "hostname"]) ?? first;
  return url && requestControlsTarget(url) ? url : null;
}

const REDIRECT_RECEIVER = /^(?:NextResponse|Response)$/;

/** The redirect target, when request data can send users to another site. */
function openRedirectTarget(call: CallExpression): Node | null {
  const expression = call.getExpression();
  let target: Node | undefined;
  if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getName() === "redirect" &&
    REDIRECT_RECEIVER.test(expression.getExpression().getText())
  ) {
    target = call.getArguments()[0];
  } else if (responseCall(call)?.method === "redirect") {
    // Express also accepts redirect(status, url).
    target = call.getArguments().at(-1);
  }
  return target && requestControlsTarget(target) ? target : null;
}

const NON_HTML_TYPE =
  /json|text\/(?:plain|csv|event-stream)|octet-stream|application\/xml/i;
/** A content type set before the body: `res.type("json")`, `setHeader(...)`. */
const DECLARED_NON_HTML_TYPE =
  /(?:content-type["'`]?\s*[,:]\s*|\.(?:type|contentType)\(\s*)["'`](?:json|text\/(?:plain|csv|event-stream)|application\/(?:json|xml|octet-stream))/i;
/** Parsed request objects, which Express sends as JSON rather than HTML. */
const REQUEST_OBJECT_VALUE =
  /(?:^|\.)(?:body|cookies|headers|params|query)$|\.(?:formData|json)\(\)$/;

/** True when request data is written into a response body served as HTML. */
function reflectsRequestData(body: Node | undefined): boolean {
  if (!body) return false;
  const value = unwrap(body);
  // `const { name } = req.query` binds one field, not the parsed object.
  if (
    Node.isIdentifier(value) &&
    value
      .getSymbol()
      ?.getDeclarations()
      .some((declaration) => Node.isBindingElement(declaration))
  ) {
    return isRequestValue(value);
  }
  const parts = stringParts(value);
  if (parts.length === 1) {
    const [part] = parts;
    return (
      typeof part !== "string" &&
      !REQUEST_OBJECT_VALUE.test(unwrap(part).getText()) &&
      isRequestValue(part)
    );
  }
  return parts.some((part) => typeof part !== "string" && isRequestValue(part));
}

function reflectedResponseBody(call: CallExpression): Node | null {
  const response = responseCall(call);
  // Fastify's reply.send() serves strings as text/plain.
  if (
    !response ||
    !["end", "send", "write"].includes(response.method) ||
    /^reply\b/.test(call.getExpression().getText())
  ) {
    return null;
  }
  if (
    response.chain.some((link) => NON_HTML_TYPE.test(link.getText())) ||
    DECLARED_NON_HTML_TYPE.test(enclosingScope(call).getText())
  ) {
    return null;
  }
  const [body] = call.getArguments();
  return body && reflectsRequestData(body) ? body : null;
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
  const commands = moduleBindings(
    sourceFile,
    CHILD_PROCESS_MODULES,
    COMMAND_FUNCTIONS,
  );
  const files = moduleBindings(sourceFile, FS_MODULES, FILE_FUNCTIONS);

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

    if (moduleCall(call, commands, CHILD_PROCESS_MODULES, COMMAND_FUNCTIONS)) {
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

    if (traversalPath(call, files)) {
      issues.push({
        ...fromRule("path-traversal"),
        message: "A file path is built from request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Resolve the path against a fixed base directory and reject it unless it stays inside, or use path.basename() for plain file names",
      });
    }

    if (forgedRequestUrl(call)) {
      issues.push({
        ...fromRule("server-side-request-forgery"),
        message: "An outgoing HTTP request uses a URL chosen by request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Fix the scheme and host in code, or check the parsed URL's host against an allowlist before sending the request",
      });
    }

    if (openRedirectTarget(call)) {
      issues.push({
        ...fromRule("open-redirect"),
        message: "A redirect target comes from request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Redirect only to same-site paths (one leading slash) or to hosts on an allowlist",
      });
    }

    if (reflectedResponseBody(call)) {
      issues.push({
        ...fromRule("reflected-xss"),
        message:
          "Request data is written into an HTML response without escaping",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Render through an escaping template engine, escape the value for HTML, or send JSON with res.json()",
      });
    }
  }

  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    const constructorName = expression.getExpression().getText();
    const [body, init] = expression.getArguments();
    if (
      REDIRECT_RECEIVER.test(constructorName) &&
      init &&
      /text\/html/i.test(init.getText()) &&
      reflectsRequestData(body)
    ) {
      issues.push({
        ...fromRule("reflected-xss"),
        message:
          "Request data is written into an HTML response without escaping",
        ...sourceLocation(file, expression.getStartLineNumber()),
        fix: "Render through an escaping template engine, escape the value for HTML, or return JSON",
      });
      continue;
    }
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
