import {
  type MethodDeclaration,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  definition,
  exportedValue,
  type FunctionLike,
  isFunctionLike,
  literalText,
  methodName,
  type ModuleIndex,
  moduleOf,
  objectLiteral,
  propertyValue,
  unwrap,
} from "./fastify-plugins.js";

/**
 * Whether a Next.js middleware (`proxy` in Next.js 16) turns an anonymous
 * request to a path away before it reaches the route. The middleware runs
 * only for paths its `matcher` covers; next-auth v4's middleware, Clerk's
 * `auth.protect()`, Auth.js v5's `auth` and its `authorized` callback, and
 * custom functions are each judged for that one path. Functions are run
 * symbolically for a request without a session: `if` conditions that compare
 * the pathname with literals or test the caller's identity are decided, and
 * anything else leaves the outcome open, which falls back to looking for an
 * `if (!session)` guard anywhere in the file.
 */

/** A value naming the caller: `session`, `token`, `req.auth`, `user`. */
const IDENTITY = /(?:session|token|auth|user|userId|identity|viewer|jwt)\b/i;
/** A response that turns an anonymous request away. */
const REJECTION =
  /\bredirect\s*\(|\brewrite\s*\(|status\s*:\s*40[13]\b|\b40[13]\b/;
const NEXT_RESPONSE_NEXT = /^NextResponse\.next\s*\(/;
const PATHNAME = /(?:^|\.)pathname$/;
const NEXT_AUTH_MIDDLEWARE = "next-auth/middleware";
const MIDDLEWARE_FILES = ["middleware", "src/middleware", "proxy", "src/proxy"];
const MIDDLEWARE_EXTENSIONS = [".ts", ".js", ".mjs"];
/** The exports Next.js runs as middleware. */
const ENTRY_NAMES = ["middleware", "proxy", "default"];
/** Bounds the variables, imports, and spreads followed while evaluating. */
const MAX_DEPTH = 4;
/** Bounds the helpers followed from `return helper(request)`. */
const MAX_HELPER_CALLS = 2;

type Callable = FunctionLike | MethodDeclaration;

/** How a function ends for the anonymous request, or "unknown". */
type Verdict = "rejected" | "allowed" | "unknown";

/**
 * How returns are read: a middleware function, an `authorized` callback
 * whose falsy result redirects to sign-in, or one that runs before a custom
 * function, where only a returned Response stops the request.
 */
type Mode = "middleware" | "authorized" | "authorized-response";

type Entry =
  | { kind: "function"; fn: Callable }
  | {
      kind: "authjs";
      config: ObjectLiteralExpression | undefined;
      wrapped: Callable | undefined;
    };

const UNKNOWN = Symbol("unknown");
/** A value for the anonymous request; null is its missing session or user. */
type Value = boolean | string | null | typeof UNKNOWN;

/** `if (!session) throw ...` or `if (!token) return redirect(...)`. */
export function guardsAnonymous(
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

/** The function a node holds, through variables and imports. */
export function functionValue(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): Callable | undefined {
  if (!node || depth > MAX_DEPTH) return undefined;
  const value = definition(index, node);
  if (isFunctionLike(value) || Node.isMethodDeclaration(value)) return value;
  if (Node.isVariableDeclaration(value)) {
    return functionValue(index, value.getInitializer(), depth + 1);
  }
  return undefined;
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

function isConstant(node: Node): boolean {
  return (
    Node.isVariableDeclaration(node) &&
    node.getVariableStatement()?.getDeclarationKind() === "const"
  );
}

function truthy(value: Exclude<Value, typeof UNKNOWN>): boolean {
  return Boolean(value);
}

/** `pathname.startsWith("/api")`, `["/a", "/b"].includes(pathname)`. */
function stringTest(
  index: ModuleIndex,
  call: Node,
  path: string,
  depth: number,
): Value {
  if (!Node.isCallExpression(call)) return UNKNOWN;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return UNKNOWN;
  const name = callee.getName();
  if (!["startsWith", "endsWith", "includes"].includes(name)) return UNKNOWN;
  const argument = call.getArguments()[0];
  const tested = argument
    ? evaluate(index, argument, path, depth + 1)
    : UNKNOWN;
  if (typeof tested !== "string") return UNKNOWN;
  const receiver = unwrap(callee.getExpression());
  if (name === "includes" && Node.isArrayLiteralExpression(receiver)) {
    const items = receiver.getElements().map(literalText);
    return items.every((item) => item !== null)
      ? items.includes(tested)
      : UNKNOWN;
  }
  const subject = evaluate(index, receiver, path, depth + 1);
  if (typeof subject !== "string") return UNKNOWN;
  if (name === "startsWith") return subject.startsWith(tested);
  if (name === "endsWith") return subject.endsWith(tested);
  return subject.includes(tested);
}

function binaryValue(
  index: ModuleIndex,
  node: Node,
  path: string,
  depth: number,
): Value {
  if (!Node.isBinaryExpression(node)) return UNKNOWN;
  const operator = node.getOperatorToken().getKind();
  const left = evaluate(index, node.getLeft(), path, depth + 1);
  const right = () => evaluate(index, node.getRight(), path, depth + 1);
  switch (operator) {
    case SyntaxKind.AmpersandAmpersandToken: {
      if (left !== UNKNOWN) return truthy(left) ? right() : left;
      // Unknown && false is falsy whatever the left side was.
      const value = right();
      return value !== UNKNOWN && !truthy(value) ? false : UNKNOWN;
    }
    case SyntaxKind.BarBarToken: {
      if (left !== UNKNOWN) return truthy(left) ? left : right();
      const value = right();
      return value !== UNKNOWN && truthy(value) ? true : UNKNOWN;
    }
    case SyntaxKind.QuestionQuestionToken:
      return left === UNKNOWN ? UNKNOWN : left === null ? right() : left;
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken: {
      const other = right();
      if (left === UNKNOWN || other === UNKNOWN) return UNKNOWN;
      const equal = left === other;
      return operator === SyntaxKind.EqualsEqualsEqualsToken ||
        operator === SyntaxKind.EqualsEqualsToken
        ? equal
        : !equal;
    }
    default:
      return UNKNOWN;
  }
}

/** A reference: the pathname, a constant, the caller's identity, or unknown. */
function referenceValue(
  index: ModuleIndex,
  node: Node,
  path: string,
  depth: number,
): Value {
  const text = node.getText();
  if (PATHNAME.test(text)) return path;
  if (Node.isIdentifier(node)) {
    if (text === "undefined") return null;
    const declaration = definition(index, node);
    const initializer =
      declaration &&
      isConstant(declaration) &&
      Node.isVariableDeclaration(declaration)
        ? declaration.getInitializer()
        : undefined;
    if (initializer) return evaluate(index, initializer, path, depth + 1);
  }
  if (IDENTITY.test(text)) return null;
  // auth?.user and session.user are missing when auth or session is.
  if (Node.isPropertyAccessExpression(node)) {
    return evaluate(index, node.getExpression(), path, depth + 1) === null
      ? null
      : UNKNOWN;
  }
  return UNKNOWN;
}

/** The value an expression has for an anonymous request to `path`. */
function evaluate(
  index: ModuleIndex,
  node: Node,
  path: string,
  depth = 0,
): Value {
  if (depth > MAX_DEPTH * 2) return UNKNOWN;
  const value = unwrap(node);
  if (Node.isTrueLiteral(value)) return true;
  if (Node.isFalseLiteral(value)) return false;
  if (Node.isNullLiteral(value)) return null;
  const literal = literalText(value);
  if (literal !== null) return literal;
  if (
    Node.isPrefixUnaryExpression(value) &&
    value.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    const operand = evaluate(index, value.getOperand(), path, depth + 1);
    return operand === UNKNOWN ? UNKNOWN : !truthy(operand);
  }
  if (Node.isBinaryExpression(value)) {
    return binaryValue(index, value, path, depth);
  }
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
    if (callee.getText() === "Boolean") {
      const [argument] = value.getArguments();
      const inner = argument
        ? evaluate(index, argument, path, depth + 1)
        : false;
      return inner === UNKNOWN ? UNKNOWN : truthy(inner);
    }
    const tested = stringTest(index, value, path, depth);
    if (tested !== UNKNOWN) return tested;
    // auth(), getSession(req), cookies().get("token") find no session.
    return IDENTITY.test(value.getText()) ? null : UNKNOWN;
  }
  if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
    return referenceValue(index, value, path, depth);
  }
  return UNKNOWN;
}

/** The request being judged and how a function's returns are read. */
interface Run {
  index: ModuleIndex;
  path: string;
  mode: Mode;
  /** Project functions entered through `return helper(request)`. */
  calls: number;
}

/** What a `return` means in each mode. */
function returned(run: Run, node: Node | undefined): Verdict {
  if (!node) return run.mode === "authorized" ? "rejected" : "allowed";
  const value = unwrap(node);
  const text = value.getText();
  if (REJECTION.test(text)) return "rejected";
  if (NEXT_RESPONSE_NEXT.test(text)) return "allowed";
  if (run.mode === "middleware") {
    // return updateSession(request): the project helper decides.
    const helper = Node.isCallExpression(value)
      ? functionValue(run.index, value.getExpression())
      : undefined;
    return helper && run.calls < MAX_HELPER_CALLS
      ? verdict({ ...run, calls: run.calls + 1 }, helper)
      : "unknown";
  }
  // Anything but a Response leaves the decision to the custom function.
  if (run.mode === "authorized-response") return "allowed";
  const result = evaluate(run.index, node, run.path);
  if (result === UNKNOWN) return "unknown";
  return truthy(result) ? "allowed" : "rejected";
}

/** Runs statements in order; "next" means control reached their end. */
function block(run: Run, statements: Node[]): Verdict | "next" {
  for (const statement of statements) {
    const outcome = step(run, statement);
    if (outcome !== "next") return outcome;
  }
  return "next";
}

function step(run: Run, statement: Node): Verdict | "next" {
  if (Node.isBlock(statement)) return block(run, statement.getStatements());
  if (Node.isIfStatement(statement)) {
    const condition = evaluate(run.index, statement.getExpression(), run.path);
    const otherwise = statement.getElseStatement();
    if (condition === UNKNOWN) {
      // An undecided branch only matters when the two branches differ.
      const then = step(run, statement.getThenStatement());
      const other = otherwise ? step(run, otherwise) : "next";
      return then === other ? then : "unknown";
    }
    if (truthy(condition)) return step(run, statement.getThenStatement());
    return otherwise ? step(run, otherwise) : "next";
  }
  if (Node.isReturnStatement(statement)) {
    return returned(run, statement.getExpression());
  }
  if (Node.isThrowStatement(statement)) return "rejected";
  if (Node.isVariableStatement(statement) || Node.isEmptyStatement(statement)) {
    return "next";
  }
  if (Node.isExpressionStatement(statement)) {
    // A call that may reject on its own, such as auth.protect() or redirect().
    return /\bprotect\s*\(|\bauth\s*\(|\bredirect\s*\(/.test(
      statement.getText(),
    )
      ? "unknown"
      : "next";
  }
  return "unknown";
}

function verdict(run: Run, fn: Callable): Verdict {
  const body = fn.getBody();
  if (!body) return "unknown";
  const outcome = Node.isBlock(body)
    ? block(run, body.getStatements())
    : returned(run, body);
  if (outcome !== "next") return outcome;
  // An authorized callback that returns nothing is falsy.
  return run.mode === "authorized" ? "rejected" : "allowed";
}

/**
 * A property of an object literal, looking through spreads such as
 * `{ ...authConfig, providers }`. Undefined when it is absent, null when a
 * spread cannot be resolved.
 */
function property(
  index: ModuleIndex,
  object: ObjectLiteralExpression,
  name: string,
  depth = 0,
): Node | null | undefined {
  for (const candidate of object.getProperties().reverse()) {
    if (Node.isSpreadAssignment(candidate)) {
      const spread = objectLiteral(index, candidate.getExpression());
      if (!spread || depth >= MAX_DEPTH) return null;
      const found = property(index, spread, name, depth + 1);
      if (found !== undefined) return found;
    } else if (
      (Node.isPropertyAssignment(candidate) ||
        Node.isShorthandPropertyAssignment(candidate) ||
        Node.isMethodDeclaration(candidate)) &&
      candidate.getName() === name
    ) {
      return candidate;
    }
  }
  return undefined;
}

/** The config passed to NextAuth(), or null when the call is not NextAuth(). */
function nextAuthConfig(
  index: ModuleIndex,
  node: Node,
): { config: ObjectLiteralExpression | undefined } | null {
  const call = unwrap(node);
  if (!Node.isCallExpression(call)) return null;
  if (moduleOf(call.getExpression()) !== "next-auth") return null;
  return { config: objectLiteral(index, call.getArguments()[0]) };
}

/** The Auth.js instance an `auth` value belongs to: `NextAuth(config).auth` or a destructured `auth`. */
function authjsOf(
  index: ModuleIndex,
  node: Node,
): { config: ObjectLiteralExpression | undefined } | null {
  const value = unwrap(node);
  if (Node.isPropertyAccessExpression(value)) {
    return value.getName() === "auth"
      ? nextAuthConfig(index, value.getExpression())
      : null;
  }
  const declaration = Node.isBindingElement(value)
    ? value
    : Node.isIdentifier(value)
      ? definition(index, value)
      : undefined;
  if (!Node.isBindingElement(declaration)) return null;
  const name =
    declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
  const initializer = declaration
    .getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    ?.getInitializer();
  return name === "auth" && initializer
    ? nextAuthConfig(index, initializer)
    : null;
}

/** What an exported middleware value is: a function or Auth.js's `auth`. */
function entryOf(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): Entry | null {
  if (!node || depth > MAX_DEPTH) return null;
  const value = unwrap(node);
  if (isFunctionLike(value)) return { kind: "function", fn: value };
  if (Node.isVariableDeclaration(value)) {
    return entryOf(index, value.getInitializer(), depth + 1);
  }
  const authjs = authjsOf(index, value);
  if (authjs)
    return { kind: "authjs", config: authjs.config, wrapped: undefined };
  if (Node.isCallExpression(value)) {
    // auth(fn), withAuth(fn), clerkMiddleware(fn)
    const fn = value
      .getArguments()
      .map((argument) => functionValue(index, argument))
      .find((candidate) => candidate !== undefined);
    const wrapper = authjsOf(index, value.getExpression());
    if (wrapper) return { kind: "authjs", config: wrapper.config, wrapped: fn };
    return fn ? { kind: "function", fn } : null;
  }
  if (Node.isIdentifier(value) || Node.isExportSpecifier(value)) {
    const resolved = definition(index, value);
    return resolved && resolved !== value
      ? entryOf(index, resolved, depth + 1)
      : null;
  }
  return null;
}

function authorizedCallback(
  index: ModuleIndex,
  config: ObjectLiteralExpression,
): Callable | null | undefined {
  const callbacks = property(index, config, "callbacks");
  if (callbacks === null || callbacks === undefined) return callbacks;
  const object = objectLiteral(index, propertyValue(callbacks));
  if (!object) return null;
  const authorized = property(index, object, "authorized");
  if (authorized === null || authorized === undefined) return authorized;
  return functionValue(index, propertyValue(authorized)) ?? null;
}

/** The outcome of the file's exported middleware for an anonymous request. */
function entryVerdict(
  index: ModuleIndex,
  sourceFile: SourceFile,
  path: string,
): Verdict {
  const exported = ENTRY_NAMES.map((name) =>
    exportedValue(sourceFile, name),
  ).find((value) => value !== undefined);
  const entry = entryOf(index, exported);
  if (!entry) return "unknown";
  if (entry.kind === "function") {
    return verdict({ index, path, mode: "middleware", calls: 0 }, entry.fn);
  }
  if (!entry.config) return "unknown";
  const authorized = authorizedCallback(index, entry.config);
  if (authorized === null) return "unknown";
  if (entry.wrapped) {
    const response = authorized
      ? verdict(
          { index, path, mode: "authorized-response", calls: 0 },
          authorized,
        )
      : "allowed";
    return response === "rejected"
      ? "rejected"
      : verdict({ index, path, mode: "middleware", calls: 0 }, entry.wrapped);
  }
  // Without an authorized callback, Auth.js lets every request through.
  return authorized
    ? verdict({ index, path, mode: "authorized", calls: 0 }, authorized)
    : "allowed";
}

/** The project's middleware or proxy file, if any. */
export function middlewareFile(
  index: ModuleIndex,
): { file: string; sourceFile: SourceFile } | null {
  for (const name of MIDDLEWARE_FILES) {
    for (const extension of MIDDLEWARE_EXTENSIONS) {
      const file = `${name}${extension}`;
      const sourceFile = index.files.get(file);
      if (sourceFile) return { file, sourceFile };
    }
  }
  return null;
}

/** True when the middleware runs for the path and turns anonymous requests to it away. */
export function middlewareRejects(
  index: ModuleIndex,
  sourceFile: SourceFile,
  path: string,
): boolean {
  if (!runsFor(index, sourceFile, path)) return false;
  // next-auth v4's middleware redirects every request without a token.
  const nextAuth = [
    ...sourceFile.getExportDeclarations(),
    ...sourceFile.getImportDeclarations(),
  ].some(
    (declaration) =>
      declaration.getModuleSpecifierValue() === NEXT_AUTH_MIDDLEWARE,
  );
  if (nextAuth || protectsPath(index, sourceFile, path)) return true;
  const outcome = entryVerdict(index, sourceFile, path);
  if (outcome !== "unknown") return outcome === "rejected";
  return guardsAnonymous(sourceFile, (branch) =>
    REJECTION.test(branch.getText()),
  );
}
