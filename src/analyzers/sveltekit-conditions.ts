import { type CallExpression, Node, SyntaxKind } from "ts-morph";
import {
  definition,
  importSource,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  unwrap,
} from "./fastify-plugins.js";
import type { Route } from "./sveltekit-routes.js";

/**
 * Evaluates the conditions under which a SvelteKit hook or handler rejects a
 * request, for one anonymous request to one route: `!event.locals.user` holds,
 * `event.url.pathname.startsWith('/admin')` holds for /admin routes, and
 * anything else is unknown. Unknown conditions are given the benefit of the
 * doubt, so a guard is never missed because of code the scan cannot read.
 * Each condition is compiled once; a hook is then evaluated for every route
 * by comparing strings only.
 */

/** True, false, or undefined when the scan cannot tell. */
export type Tri = boolean | undefined;

/** How surely an expression names the caller: `locals.user` or `session`. */
export type Strength = "strong" | "weak";

export interface Condition {
  node: Node;
  /** The value the condition has where the guarded code runs. */
  holds: boolean;
}

/** A condition's value for an anonymous request; null when no route applies. */
type Predicate = (route: Route | null) => Tri;
/** Strings that callback parameters stand for: `p` in `list.some((p) => ...)`. */
type Env = ReadonlyMap<Node, readonly string[]>;
type Subject = "pathname" | "id";

const NO_ENV: Env = new Map();
const UNKNOWN: Predicate = () => undefined;
const FALSE: Predicate = () => false;
const constant =
  (value: boolean): Predicate =>
  () =>
    value;

/** Parameter names that hold the caller: `function requireUser(user)`. */
const IDENTITY_NAME =
  /(?:session|user|auth|token|jwt|viewer|identity|principal|claims)$/i;
/** Calls that look the caller up: `getSession()`, `getCurrentUser()`, `auth()`. */
const IDENTITY_CALL =
  /^(?:get|load|fetch|read|validate|verify|require|ensure|assert)?(?:Server|Current|Auth|Authenticated|LoggedIn|SignedIn|Request)?(?:Session|User|Viewer|Identity|Principal|Claims)(?:From\w+|OrThrow|OrFail|OrRedirect)?$|^auth$/i;
/** Headers that carry credentials or a webhook signature. */
const AUTH_HEADER =
  /^(?:authorization|cookie|x-api-key|api-key)$|signature|^x-[\w-]*(?:token|secret)$/i;
const EQUALITY = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);
/** Bounds the declarations followed from a condition to the caller. */
const MAX_IDENTITY_DEPTH = 3;
const MAX_VALUE_DEPTH = 4;

/**
 * Per-node results, computed once per scan: a hook is evaluated for every
 * route, and its conditions would otherwise be read again each time.
 */
const identityMemo = new Map<number, WeakMap<Node, Strength | null>>();
const subjectMemo = new WeakMap<Node, Subject | null>();
const arrayMemo = new WeakMap<Node, readonly string[] | null>();
const stringMemo = new WeakMap<Node, readonly string[] | null>();
const predicateMemo = new WeakMap<Node, Predicate>();
const partsMemo = new Map<string, ReadonlyArray<string | null>>();

function memoized<T>(memo: WeakMap<Node, T>, node: Node, compute: () => T): T {
  if (memo.has(node)) return memo.get(node) as T;
  const value = compute();
  memo.set(node, value);
  return value;
}

export function not(value: Tri): Tri {
  return value === undefined ? undefined : !value;
}

export function and(left: Tri, right: Tri): Tri {
  if (left === false || right === false) return false;
  return left === true && right === true ? true : undefined;
}

function or(left: Tri, right: Tri): Tri {
  if (left === true || right === true) return true;
  return left === false && right === false ? false : undefined;
}

function anyOf(values: readonly Tri[]): Tri {
  return values.reduce<Tri>(or, false);
}

function allOf(values: readonly Tri[]): Tri {
  return values.reduce<Tri>(and, true);
}

/** Source text without whitespace, optional chaining, or non-null assertions. */
export function normalized(node: Node): string {
  return node
    .getText()
    .replace(/\s+/g, "")
    .replace(/\?\./g, ".")
    .replace(/!(?=\.|$)/g, "");
}

/** The `@sveltejs/kit` export a callee is: `redirect`, `error`, `fail`. */
export function kitExport(callee: Node): string | null {
  if (!Node.isIdentifier(callee)) return null;
  const declaration = callee.getSymbol()?.getDeclarations()[0];
  const source = declaration ? importSource(declaration) : null;
  return source?.specifier === "@sveltejs/kit" ? source.name : null;
}

/** Calls that throw: SvelteKit's redirect() and error(). */
export function neverReturns(call: CallExpression): boolean {
  const name = kitExport(call.getExpression());
  return name === "redirect" || name === "error";
}

function isPropertyName(identifier: Node): boolean {
  const parent = identifier.getParent();
  return (
    (Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === identifier) ||
    (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier)
  );
}

/** Property names from a binding to its parameter or variable: `locals`, `user`. */
function bindingPath(binding: Node): string[] {
  const names: string[] = [];
  let current: Node | undefined = binding;
  while (Node.isBindingElement(current)) {
    names.push(current.getPropertyNameNode()?.getText() ?? current.getName());
    current = current.getParent()?.getParent();
  }
  return names;
}

function declaredIdentity(
  index: ModuleIndex,
  identifier: Node,
  depth: number,
): Strength | null {
  const declaration = identifier.getSymbol()?.getDeclarations()[0];
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    return initializer ? identityOf(index, initializer, depth + 1) : null;
  }
  if (Node.isBindingElement(declaration)) {
    if (bindingPath(declaration).includes("locals")) return "strong";
    const root = declaration.getFirstAncestor(
      (ancestor) =>
        Node.isVariableDeclaration(ancestor) ||
        Node.isParameterDeclaration(ancestor),
    );
    const initializer = Node.isVariableDeclaration(root)
      ? root.getInitializer()
      : undefined;
    const fromValue = initializer && identityOf(index, initializer, depth + 1);
    if (fromValue) return fromValue;
    return Node.isParameterDeclaration(root) &&
      IDENTITY_NAME.test(declaration.getName())
      ? "weak"
      : null;
  }
  return Node.isParameterDeclaration(declaration) &&
    IDENTITY_NAME.test(declaration.getName())
    ? "weak"
    : null;
}

function identityPart(
  index: ModuleIndex,
  part: Node,
  depth: number,
): Strength | null {
  if (Node.isIdentifier(part)) {
    if (part.getText() === "locals") return "strong";
    if (isPropertyName(part) || depth >= MAX_IDENTITY_DEPTH) return null;
    return declaredIdentity(index, part, depth);
  }
  if (!Node.isCallExpression(part)) return null;
  const callee = part.getExpression();
  const name = Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : callee.getText();
  const receiver = Node.isPropertyAccessExpression(callee)
    ? normalized(callee.getExpression())
    : "";
  if (name === "getRequestEvent") return "strong";
  if (name === "get" && /(?:^|\.)cookies$/.test(receiver)) return "strong";
  if (
    name === "get" &&
    /(?:^|\.)headers$/.test(receiver) &&
    AUTH_HEADER.test(literalText(part.getArguments()[0]) ?? "")
  ) {
    return "strong";
  }
  return IDENTITY_CALL.test(name) ? "weak" : null;
}

/**
 * Whether an expression is about the caller: strong when it reads
 * `event.locals`, the session cookie, or an auth header, directly or through
 * variables; weak when only a name says so (`getSession()`, a `user` parameter).
 */
export function identityOf(
  index: ModuleIndex,
  node: Node,
  depth = 0,
): Strength | null {
  const memo = identityMemo.get(depth) ?? new WeakMap();
  identityMemo.set(depth, memo);
  return memoized(memo, node, () => {
    let found: Strength | null = null;
    for (const part of [node, ...node.getDescendants()]) {
      const strength = identityPart(index, part, depth);
      if (strength === "strong") return strength;
      found ??= strength;
    }
    return found;
  });
}

/** Which part of the URL an expression is: the pathname or the route id. */
function subjectOf(index: ModuleIndex, node: Node): Subject | null {
  return memoized(subjectMemo, node, () => findSubject(index, node, 0));
}

function findSubject(
  index: ModuleIndex,
  node: Node,
  depth: number,
): Subject | null {
  const value = unwrap(node);
  const text = normalized(value);
  if (/(?:^|\.)pathname$/.test(text)) return "pathname";
  if (/(?:^|\.)route\.id$|^routeId$/.test(text)) return "id";
  if (!Node.isIdentifier(value) || depth >= MAX_VALUE_DEPTH) return null;
  const declaration = definition(index, value);
  const initializer = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : undefined;
  return initializer ? findSubject(index, initializer, depth + 1) : null;
}

/** The strings an array holds: a literal, or a constant holding one. */
function arrayValues(index: ModuleIndex, node: Node): readonly string[] | null {
  return memoized(arrayMemo, node, () => findArray(index, node, 0));
}

function findArray(
  index: ModuleIndex,
  node: Node,
  depth: number,
): readonly string[] | null {
  const value = unwrap(node);
  if (Node.isArrayLiteralExpression(value)) {
    const values = value.getElements().map((element) => literalText(element));
    return values.every((text) => text !== null) ? (values as string[]) : null;
  }
  if (depth >= MAX_VALUE_DEPTH) return null;
  const declaration = definition(index, value);
  const initializer = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : undefined;
  return initializer ? findArray(index, initializer, depth + 1) : null;
}

/** The strings a value can be: a literal, a constant, or a loop variable. */
function stringValues(
  index: ModuleIndex,
  node: Node,
  env: Env,
): readonly string[] | null {
  // Callback parameters stand for different strings in each compilation.
  return env.size === 0
    ? memoized(stringMemo, node, () => findStrings(index, node, env, 0))
    : findStrings(index, node, env, 0);
}

function findStrings(
  index: ModuleIndex,
  node: Node,
  env: Env,
  depth: number,
): readonly string[] | null {
  const value = unwrap(node);
  const text = literalText(value);
  if (text !== null) return [text];
  if (depth >= MAX_VALUE_DEPTH) return null;
  const declaration = definition(index, value);
  if (!declaration || declaration === value) return null;
  const bound = env.get(declaration);
  if (bound) return bound;
  if (!Node.isVariableDeclaration(declaration)) return null;
  const loop = declaration.getParent()?.getParent();
  if (Node.isForOfStatement(loop)) {
    return findArray(index, loop.getExpression(), depth + 1);
  }
  const initializer = declaration.getInitializer();
  return initializer ? findStrings(index, initializer, env, depth + 1) : null;
}

/** Literal characters of a route pattern, with `null` for a dynamic segment. */
function patternParts(pattern: string): ReadonlyArray<string | null> {
  const cached = partsMemo.get(pattern);
  if (cached) return cached;
  const parts = pattern.split(/(\[[^\]]*\]+)/).flatMap((part) => {
    if (part === "") return [];
    return part.startsWith("[") ? [null] : [...part];
  });
  partsMemo.set(pattern, parts);
  return parts;
}

function startsWithPattern(pattern: string, prefix: string): Tri {
  const parts = patternParts(pattern);
  for (let position = 0; position < prefix.length; position++) {
    const part = parts[position];
    // The prefix reaches into a parameter, or only adds a trailing slash.
    if (part === null) return undefined;
    if (part === undefined) {
      return prefix.slice(position) === "/" ? undefined : false;
    }
    if (part !== prefix[position]) return false;
  }
  return true;
}

function equalsPattern(pattern: string, value: string): Tri {
  if (!pattern.includes("[")) {
    if (pattern === value) return true;
    return value === `${pattern}/` ? undefined : false;
  }
  // Optional and rest parameters can match no segment at all.
  if (/\[\[|\[\.\.\./.test(pattern)) return undefined;
  const source = pattern
    .split(/(\[[^\]]*\]+)/)
    .map((part) =>
      part.startsWith("[") ? ".*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(value) ? undefined : false;
}

function compareSubject(
  route: Route,
  subject: Subject,
  method: string,
  value: string,
): Tri {
  if (subject === "id") {
    if (method === "startsWith") return route.id.startsWith(value);
    if (method === "includes") return route.id.includes(value);
    if (method === "endsWith") return route.id.endsWith(value);
    return route.id === value;
  }
  if (method === "startsWith") return startsWithPattern(route.path, value);
  if (method === "equals") return equalsPattern(route.path, value);
  if (route.path.includes("[")) return undefined;
  return method === "includes"
    ? route.path.includes(value)
    : route.path.endsWith(value);
}

/** Whether a route's pathname or id matches any of the strings. */
function matching(
  subject: Subject,
  method: string,
  values: readonly string[],
): Predicate {
  return (route) =>
    route
      ? anyOf(
          values.map((value) => compareSubject(route, subject, method, value)),
        )
      : undefined;
}

/** `pathname.startsWith('/admin')`, `PUBLIC.includes(pathname)`, `LIST.some(...)`. */
function compileCall(
  index: ModuleIndex,
  call: CallExpression,
  env: Env,
): Predicate | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const method = callee.getName();
  const receiver = callee.getExpression();
  const [first] = call.getArguments();
  if (!first) return null;
  if (["startsWith", "includes", "endsWith"].includes(method)) {
    const subject = subjectOf(index, receiver);
    if (subject) {
      const values = stringValues(index, first, env);
      return values ? matching(subject, method, values) : UNKNOWN;
    }
  }
  if (method === "includes") {
    const subject = subjectOf(index, first);
    const values = subject && arrayValues(index, receiver);
    return subject && values ? matching(subject, "equals", values) : null;
  }
  if (["some", "find", "every"].includes(method) && isFunctionLike(first)) {
    const values = arrayValues(index, receiver);
    const [parameter] = first.getParameters();
    const body = callbackResult(first.getBody());
    if (!values || !parameter || !body) return null;
    const predicates = values.map((value) =>
      predicateOf(index, body, new Map([...env, [parameter, [value]]])),
    );
    return (route) => {
      const results = predicates.map((predicate) => predicate(route));
      return method === "every" ? allOf(results) : anyOf(results);
    };
  }
  if (method === "test" && Node.isRegularExpressionLiteral(receiver)) {
    const subject = subjectOf(index, first);
    if (!subject) return null;
    let pattern: RegExp;
    try {
      pattern = receiver.getLiteralValue();
    } catch {
      return UNKNOWN;
    }
    return (route) => {
      const value = subject === "id" ? route?.id : route?.path;
      if (value === undefined) return undefined;
      if (subject === "pathname" && value.includes("[")) return undefined;
      pattern.lastIndex = 0;
      return pattern.test(value);
    };
  }
  return null;
}

/** What a callback returns: its expression body or a lone return statement. */
function callbackResult(body: Node | undefined): Node | undefined {
  if (!Node.isBlock(body)) return body;
  const [statement, ...rest] = body.getStatements();
  return Node.isReturnStatement(statement) && rest.length === 0
    ? statement.getExpression()
    : undefined;
}

function isNullish(node: Node): boolean {
  const value = unwrap(node);
  return (
    value.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(value) && value.getText() === "undefined") ||
    Node.isVoidExpression(value)
  );
}

function compileComparison(
  index: ModuleIndex,
  binary: Node,
  env: Env,
): Predicate {
  if (!Node.isBinaryExpression(binary)) return UNKNOWN;
  const kind = binary.getOperatorToken().getKind();
  const negated =
    kind === SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsToken;
  const sides = [binary.getLeft(), binary.getRight()] as const;
  for (const [subjectNode, other] of [sides, [sides[1], sides[0]] as const]) {
    const subject = subjectOf(index, subjectNode);
    const values = subject && stringValues(index, other, env);
    if (subject && values) {
      const equal = matching(subject, "equals", values);
      return negated ? (route) => not(equal(route)) : equal;
    }
  }
  for (const [identity, other] of [sides, [sides[1], sides[0]] as const]) {
    const typeOf = unwrap(identity);
    const operand = Node.isTypeOfExpression(typeOf)
      ? typeOf.getExpression()
      : identity;
    if (!identityOf(index, operand)) continue;
    // The anonymous caller's identity is null or undefined.
    const equal = Node.isTypeOfExpression(typeOf)
      ? literalText(other) === "undefined"
      : isNullish(other);
    return constant(negated ? !equal : equal);
  }
  return UNKNOWN;
}

function compile(index: ModuleIndex, node: Node, env: Env): Predicate {
  const value = unwrap(node);
  if (
    Node.isPrefixUnaryExpression(value) &&
    value.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    const operand = predicateOf(index, value.getOperand(), env);
    return (route) => not(operand(route));
  }
  if (Node.isBinaryExpression(value)) {
    const kind = value.getOperatorToken().getKind();
    if (EQUALITY.has(kind)) return compileComparison(index, value, env);
    if (
      kind !== SyntaxKind.AmpersandAmpersandToken &&
      kind !== SyntaxKind.BarBarToken
    ) {
      return UNKNOWN;
    }
    const left = predicateOf(index, value.getLeft(), env);
    const right = predicateOf(index, value.getRight(), env);
    return kind === SyntaxKind.AmpersandAmpersandToken
      ? (route) => and(left(route), right(route))
      : (route) => or(left(route), right(route));
  }
  if (Node.isCallExpression(value)) {
    const atom = compileCall(index, value, env);
    if (atom) return atom;
  }
  // The anonymous caller has no user, session, or token.
  return identityOf(index, value) ? FALSE : UNKNOWN;
}

/**
 * A condition compiled once into its value for an anonymous request to a
 * route: the syntax is read here, so evaluating it per route only compares
 * strings.
 */
function predicateOf(
  index: ModuleIndex,
  node: Node,
  env: Env = NO_ENV,
): Predicate {
  return env.size === 0
    ? memoized(predicateMemo, node, () => compile(index, node, env))
    : compile(index, node, env);
}

/** Statements that leave their block: return, throw, redirect(), error(). */
export function exits(statement: Node): boolean {
  if (Node.isReturnStatement(statement) || Node.isThrowStatement(statement)) {
    return true;
  }
  if (Node.isBlock(statement)) {
    const last = statement.getStatements().at(-1);
    return last !== undefined && exits(last);
  }
  if (Node.isExpressionStatement(statement)) {
    const call = unwrap(statement.getExpression());
    return Node.isCallExpression(call) && neverReturns(call);
  }
  if (Node.isIfStatement(statement)) {
    const otherwise = statement.getElseStatement();
    return (
      otherwise !== undefined &&
      exits(statement.getThenStatement()) &&
      exits(otherwise)
    );
  }
  return false;
}

/** Early exits before a statement: `if (C) return resolve(event);` means !C. */
function earlierExits(block: Node, statement: Node): Condition[] {
  if (
    !Node.isBlock(block) &&
    !Node.isSourceFile(block) &&
    !Node.isCaseClause(block)
  ) {
    return [];
  }
  const statements: Node[] = block.getStatements();
  return statements
    .slice(0, statements.indexOf(statement))
    .flatMap((earlier): Condition[] => {
      if (!Node.isIfStatement(earlier)) return [];
      const then = earlier.getThenStatement();
      const otherwise = earlier.getElseStatement();
      if (!otherwise && exits(then)) {
        return [{ node: earlier.getExpression(), holds: false }];
      }
      return otherwise && exits(otherwise) && !exits(then)
        ? [{ node: earlier.getExpression(), holds: true }]
        : [];
    });
}

/** Every condition that holds where a node runs, up to a function. */
export function conditionsOf(node: Node, root: Node): Condition[] {
  const conditions: Condition[] = [];
  let current = node;
  while (current !== root) {
    const parent = current.getParent();
    if (!parent) break;
    if (Node.isIfStatement(parent)) {
      if (parent.getThenStatement() === current) {
        conditions.push({ node: parent.getExpression(), holds: true });
      } else if (parent.getElseStatement() === current) {
        conditions.push({ node: parent.getExpression(), holds: false });
      }
    } else if (Node.isConditionalExpression(parent)) {
      if (parent.getWhenTrue() === current) {
        conditions.push({ node: parent.getCondition(), holds: true });
      } else if (parent.getWhenFalse() === current) {
        conditions.push({ node: parent.getCondition(), holds: false });
      }
    } else if (
      Node.isBinaryExpression(parent) &&
      parent.getRight() === current
    ) {
      const kind = parent.getOperatorToken().getKind();
      if (kind === SyntaxKind.AmpersandAmpersandToken) {
        conditions.push({ node: parent.getLeft(), holds: true });
      } else if (
        kind === SyntaxKind.BarBarToken ||
        kind === SyntaxKind.QuestionQuestionToken
      ) {
        conditions.push({ node: parent.getLeft(), holds: false });
      }
    } else {
      conditions.push(...earlierExits(parent, current));
    }
    current = parent;
  }
  return conditions;
}

/**
 * Whether every condition can hold together for an anonymous request to the
 * route; null when the route does not matter, which leaves paths unknown.
 */
export function reachable(
  index: ModuleIndex,
  route: Route | null,
  conditions: readonly Condition[],
): boolean {
  let verdict: Tri = true;
  for (const condition of conditions) {
    const value = predicateOf(index, condition.node)(route);
    verdict = and(verdict, condition.holds ? value : not(value));
    if (verdict === false) return false;
  }
  return true;
}

/** The strongest caller identity any condition reads. */
export function strongestIdentity(
  index: ModuleIndex,
  conditions: Condition[],
): Strength | null {
  let found: Strength | null = null;
  for (const condition of conditions) {
    const strength = identityOf(index, condition.node);
    if (strength === "strong") return strength;
    found ??= strength;
  }
  return found;
}
