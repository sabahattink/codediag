import { type CallExpression, Node, SyntaxKind } from "ts-morph";
import {
  definition,
  type FunctionLike,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  propertyValue,
  unwrap,
} from "./fastify-plugins.js";
import { returnedValues } from "./taint-graph.js";

/**
 * Checks on React Router actions, loaders, and middleware functions: whether
 * one rejects anonymous requests, signs a user in or out, validates the
 * submission it reads, or returns only constants. Project functions they
 * call are followed up to MAX_HELPER_DEPTH calls deep, as trpc-perimeter.ts
 * follows createContext.
 */

/** Bounds the project functions followed from a handler. */
const MAX_HELPER_DEPTH = 2;

/** A value naming the caller: `session`, `userId`, `accountId`, `token`. */
const IDENTITY =
  /session|token|auth|user|account|identity|viewer|member|principal|jwt|(?:logged|signed)in/i;
/** A credential compared with an expected value: `Authorization`, an API key. */
const CREDENTIAL = /authorization|api[-_]?key|signature|secret/i;
/** A response that turns an anonymous request away: redirect(), redirectWithToast(), 401. */
const REJECTION =
  /\bredirect\w*\s*\(|\breplace\s*\(|\b40[13]\b|unauthori[sz]ed|forbidden/i;
/**
 * Calls that enforce auth by their name: requireUserId(request),
 * authenticator.isAuthenticated(...), withAuth(handler), and webhook
 * signature checks such as stripe.webhooks.constructEvent() or Svix's
 * verify(). Lookups such as getUser() or getAuth() reject no one by
 * themselves.
 */
const AUTH_CALL =
  /^(?:require|ensure|assert|enforce|verify|check)\w*(?:user|auth|login|session|role|admin|permission|account|member|access|signedin|loggedin|signature|webhook|token|hmac)|^(?:is)?authenticat|^authori[sz]e|^protect|^with\w*auth|^verify$|^constructEvent(?:Async)?$|^timingSafeEqual$/i;
/** `invariantResponse(user, "Unauthorized", { status: 401 })` throws without a user. */
const ASSERTION = /^(?:invariant|invariantResponse|assert)$/;
/** Middleware named like an auth check: authMiddleware, requireUser. */
const AUTH_MIDDLEWARE =
  /auth(?!or)|protect|guard|require\w*(?:user|login|session|role|admin|account)/i;
/** Calls that sign a user in or out by creating or destroying the session. */
const SESSION_CALL =
  /^(?:create\w*Session|destroySession|log(?:in|out)|sign(?:in|out|up)|register(?:user)?)$/i;
const IDENTITY_KEY = /user|account|auth|member/i;
/** Schema methods: zod parse/safeParse, yup validate, remix-validated-form. */
const SCHEMA_METHODS = new Set([
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
  "validate",
  "validateAsync",
  "validateSync",
  "isValid",
  "isValidSync",
  "assert",
]);
/** Receivers whose parse() or assert() checks nothing about the submission. */
const NOT_A_SCHEMA =
  /^(?:JSON|Number|Date|URL|URLSearchParams|BigInt|Intl|Math|Object|Array|String|Reflect|Buffer|path|qs|querystring|cookie|cookies|console)$/;
/** Conform, remix-hook-form, and remix-validated-form helpers. */
const SCHEMA_FUNCTIONS =
  /^(?:parseWith\w+|getValidatedFormData|validateFormData|with(?:Zod|Yup|Valibot|Arktype)|validate\w+|sanitize\w*)$/;
/** Valibot and superstruct functions taking the schema and the value. */
const TWO_ARGUMENT_CHECKS =
  /^(?:parse|parseAsync|safeParse|safeParseAsync|validate|assert|is|create)$/;
/** A form value compared with a literal: `formData.get("intent") === "delete"`. */
const FORM_VALUE = /\.get\(|\bintent\b|\b_action\b/;
const REQUEST_ARGUMENT = /^(?:request|req|args)$/;
const REQUEST_RECEIVER = /(?:^|\.)request(?:\.clone\(\))?$|^req$/;
const BODY_METHODS = new Set(["formData", "json"]);
const EMPTY_RESPONSES = new Set(["redirect", "redirectDocument", "replace"]);
const RESPONSE_HELPERS = new Set(["json", "data"]);

export interface AuthCheck {
  auth: boolean;
  /**
   * A call receives the request but its code was not checked: a package
   * function, or a project function beyond MAX_HELPER_DEPTH.
   */
  opaque: boolean;
}

/** The name a call is made by: `requireUser`, `isAuthenticated`. */
function calleeName(call: CallExpression): string {
  const callee = unwrap(call.getExpression());
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return Node.isIdentifier(callee) ? callee.getText() : "";
}

/** The project function a node holds, through variables and imports. */
export function functionValue(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): FunctionLike | undefined {
  if (!node || depth > MAX_HELPER_DEPTH + 2) return undefined;
  const value = definition(index, node);
  if (isFunctionLike(value)) return value;
  if (Node.isVariableDeclaration(value)) {
    return functionValue(index, value.getInitializer(), depth + 1);
  }
  return undefined;
}

/** The project function a call runs: `helper()` or `auth.requireUser()`. */
function calledFunction(
  index: ModuleIndex,
  call: CallExpression,
): FunctionLike | undefined {
  const callee = unwrap(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) {
    return functionValue(index, callee);
  }
  const declaration = callee.getNameNode().getSymbol()?.getDeclarations()[0];
  if (!declaration || !index.paths.has(declaration.getSourceFile())) {
    return undefined;
  }
  if (Node.isMethodDeclaration(declaration)) return undefined;
  const value = Node.isPropertyAssignment(declaration)
    ? declaration.getInitializer()
    : declaration;
  return functionValue(index, value);
}

function passesRequest(call: CallExpression): boolean {
  return call.getArguments().some((argument) => {
    const value = unwrap(argument);
    if (Node.isObjectLiteralExpression(value)) {
      return value.getProperty("request") !== undefined;
    }
    return REQUEST_ARGUMENT.test(value.getText());
  });
}

/**
 * `!user`, `!session.has("userId")`, `user == null`, a credential that does
 * not match (`authorization !== expected`, `note.ownerId !== userId`), and
 * `||` chains of them.
 */
function deniesIdentity(condition: Node): boolean {
  const value = unwrap(condition);
  if (Node.isPrefixUnaryExpression(value)) {
    return (
      value.getOperatorToken() === SyntaxKind.ExclamationToken &&
      IDENTITY.test(value.getOperand().getText())
    );
  }
  if (!Node.isBinaryExpression(value)) return false;
  const operator = value.getOperatorToken().getKind();
  const [left, right] = [value.getLeft(), value.getRight()];
  if (operator === SyntaxKind.BarBarToken) {
    return deniesIdentity(left) || deniesIdentity(right);
  }
  const names = (node: Node) =>
    IDENTITY.test(node.getText()) || CREDENTIAL.test(node.getText());
  if (
    operator === SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === SyntaxKind.ExclamationEqualsToken
  ) {
    return names(left) || names(right);
  }
  if (
    operator !== SyntaxKind.EqualsEqualsToken &&
    operator !== SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  const empty = (node: Node) => /^(?:null|undefined)$/.test(node.getText());
  return (
    (empty(right) && IDENTITY.test(left.getText())) ||
    (empty(left) && IDENTITY.test(right.getText()))
  );
}

/** Throws, or returns a redirect or a 401/403 response. */
function rejects(branch: Node): boolean {
  if (
    Node.isThrowStatement(branch) ||
    branch.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0
  ) {
    return true;
  }
  const returns = Node.isReturnStatement(branch)
    ? [branch]
    : branch.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  return returns.some((statement) =>
    REJECTION.test(statement.getExpression()?.getText() ?? ""),
  );
}

/** `if (!user) throw redirect("/login")` and the like. */
function rejectsAnonymous(fn: Node): boolean {
  return fn
    .getDescendantsOfKind(SyntaxKind.IfStatement)
    .some(
      (statement) =>
        deniesIdentity(statement.getExpression()) &&
        rejects(statement.getThenStatement()),
    );
}

/** `context.get(userContext)`, which throws when middleware set no user. */
function readsUserContext(call: CallExpression): boolean {
  const callee = unwrap(call.getExpression());
  const [first] = call.getArguments();
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "get" &&
    /(?:^|\.)context$/.test(callee.getExpression().getText()) &&
    first !== undefined &&
    Node.isIdentifier(first) &&
    IDENTITY.test(first.getText())
  );
}

function isAuthCall(call: CallExpression): boolean {
  const name = calleeName(call);
  const [first] = call.getArguments();
  return (
    AUTH_CALL.test(name) ||
    readsUserContext(call) ||
    (ASSERTION.test(name) &&
      first !== undefined &&
      IDENTITY.test(unwrap(first).getText()))
  );
}

/**
 * True when a function was already followed at this depth or a shallower one,
 * which looked at least as far into the functions it calls.
 */
function visited(
  seen: ReadonlyMap<Node, number>,
  fn: Node,
  depth: number,
): boolean {
  const previous = seen.get(fn);
  return previous !== undefined && previous <= depth;
}

/**
 * Whether a function rejects anonymous requests itself, calls an auth check
 * such as requireUserId(), or calls a project function that does.
 */
export function checksAuth(
  index: ModuleIndex,
  fn: Node,
  depth = 0,
  seen: Map<Node, number> = new Map(),
): AuthCheck {
  seen.set(fn, depth);
  if (rejectsAnonymous(fn)) return { auth: true, opaque: false };
  let opaque = false;
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isAuthCall(call)) return { auth: true, opaque: false };
    const helper = calledFunction(index, call);
    if (helper && visited(seen, helper, depth + 1)) continue;
    if (helper && depth < MAX_HELPER_DEPTH) {
      const inner = checksAuth(index, helper, depth + 1, seen);
      if (inner.auth) return inner;
      opaque ||= inner.opaque;
    } else if (passesRequest(call)) {
      opaque = true;
    }
  }
  return { auth: false, opaque };
}

/** `withAuth(handler)`: a wrapper named like an auth check, or a project wrapper that checks auth. */
export function wrapperAuthenticates(
  index: ModuleIndex,
  call: CallExpression,
): boolean {
  if (isAuthCall(call)) return true;
  const wrapper = calledFunction(index, call);
  return wrapper !== undefined && checksAuth(index, wrapper, 1).auth;
}

/** Middleware that rejects anonymous requests, by its code or its name. */
export function middlewareAuthenticates(
  index: ModuleIndex,
  element: Node,
): boolean {
  const value = unwrap(element);
  const named = Node.isCallExpression(value) ? value.getExpression() : value;
  if (
    (Node.isIdentifier(named) || Node.isPropertyAccessExpression(named)) &&
    AUTH_MIDDLEWARE.test(named.getText())
  ) {
    return true;
  }
  const fn = isFunctionLike(value) ? value : functionValue(index, named);
  return fn !== undefined && checksAuth(index, fn).auth;
}

/** Calls in a function and in the project functions it calls. */
function someCall(
  index: ModuleIndex,
  fn: Node,
  test: (call: CallExpression) => boolean,
  depth = 0,
  seen: Map<Node, number> = new Map(),
): boolean {
  seen.set(fn, depth);
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    if (test(call)) return true;
    if (depth >= MAX_HELPER_DEPTH) return false;
    const helper = calledFunction(index, call);
    return (
      helper !== undefined &&
      !visited(seen, helper, depth + 1) &&
      someCall(index, helper, test, depth + 1, seen)
    );
  });
}

/** Signs a user in or out: createUserSession(), session.set("userId", id). */
export function changesSession(index: ModuleIndex, fn: Node): boolean {
  return someCall(index, fn, (call) => {
    if (SESSION_CALL.test(calleeName(call))) return true;
    const callee = unwrap(call.getExpression());
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === "set" &&
      /session/i.test(callee.getExpression().getText()) &&
      IDENTITY_KEY.test(literalText(call.getArguments()[0]) ?? "")
    );
  });
}

export interface BodyRead {
  method: string;
  line: number;
}

/** The first `request.formData()` or `request.json()` in a handler. */
export function bodyRead(fn: Node): BodyRead | null {
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = unwrap(call.getExpression());
    if (
      Node.isPropertyAccessExpression(callee) &&
      BODY_METHODS.has(callee.getName()) &&
      REQUEST_RECEIVER.test(unwrap(callee.getExpression()).getText())
    ) {
      return { method: callee.getName(), line: call.getStartLineNumber() };
    }
  }
  return null;
}

function isSchemaCall(call: CallExpression): boolean {
  const callee = unwrap(call.getExpression());
  if (Node.isPropertyAccessExpression(callee)) {
    return (
      SCHEMA_METHODS.has(callee.getName()) &&
      !NOT_A_SCHEMA.test(callee.getExpression().getText())
    );
  }
  if (!Node.isIdentifier(callee)) return false;
  const name = callee.getText();
  return (
    SCHEMA_FUNCTIONS.test(name) ||
    (TWO_ARGUMENT_CHECKS.test(name) && call.getArguments().length >= 2)
  );
}

/** `typeof title === "string"`, `file instanceof File`, `intent === "delete"`. */
function checksValues(fn: Node): boolean {
  if (
    fn.getDescendantsOfKind(SyntaxKind.TypeOfExpression).length > 0 ||
    fn.getDescendantsOfKind(SyntaxKind.CaseClause).length > 0
  ) {
    return true;
  }
  return fn.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((binary) => {
    const operator = binary.getOperatorToken().getKind();
    if (operator === SyntaxKind.InstanceOfKeyword) return true;
    if (
      operator !== SyntaxKind.EqualsEqualsEqualsToken &&
      operator !== SyntaxKind.ExclamationEqualsEqualsToken &&
      operator !== SyntaxKind.EqualsEqualsToken &&
      operator !== SyntaxKind.ExclamationEqualsToken
    ) {
      return false;
    }
    const [left, right] = [binary.getLeft(), binary.getRight()];
    return (
      (literalText(right) !== null && FORM_VALUE.test(left.getText())) ||
      (literalText(left) !== null && FORM_VALUE.test(right.getText()))
    );
  });
}

/**
 * Whether a handler checks the submission it reads: a schema parse in it or
 * in a project function it calls, or typeof, instanceof, and literal checks
 * of form values in the handler itself.
 */
export function validatesInput(index: ModuleIndex, fn: Node): boolean {
  return checksValues(fn) || someCall(index, fn, isSchemaCall);
}

/** A value without request-specific data: literals, redirects, `data({ ok: true })`. */
function isConstant(node: Node): boolean {
  const value = unwrap(node);
  if (
    literalText(value) !== null ||
    Node.isNumericLiteral(value) ||
    /^(?:true|false|null|undefined)$/.test(value.getText())
  ) {
    return true;
  }
  if (Node.isArrayLiteralExpression(value)) {
    return value.getElements().every(isConstant);
  }
  if (Node.isObjectLiteralExpression(value)) {
    return value.getProperties().every((property) => {
      const initializer = Node.isPropertyAssignment(property)
        ? propertyValue(property)
        : undefined;
      return initializer !== undefined && isConstant(initializer);
    });
  }
  if (Node.isNewExpression(value) || Node.isCallExpression(value)) {
    const callee = value.getExpression().getText();
    const name = callee.replace(/^.*\./, "");
    if (Node.isCallExpression(value) && EMPTY_RESPONSES.has(name)) return true;
    const isResponse =
      callee === "Response" ||
      callee === "Response.json" ||
      (Node.isCallExpression(value) && RESPONSE_HELPERS.has(callee));
    const [body] = value.getArguments();
    return isResponse && (body === undefined || isConstant(body));
  }
  return false;
}

/** A loader that returns no request-specific data, such as a redirect. */
export function returnsOnlyConstants(fn: FunctionLike): boolean {
  return returnedValues(fn).every(isConstant);
}
