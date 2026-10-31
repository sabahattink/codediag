import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";
import { moduleBindings, objectProperty, RESPONSE_OBJECT } from "./taint.js";

/** Calls whose options configure JWT signing or verification. */
const JWT_CALLEE = /jwt|sign|token/i;
/** Cookie names that suggest a session or credential. */
const SENSITIVE_COOKIE = /sess|\bsid\b|sid$|token|jwt|auth/i;
const SESSION_MODULES = new Set([
  "express-session",
  "cookie-session",
  "@fastify/session",
  "@fastify/secure-session",
]);
const COOKIE_FLAGS = ["httpOnly", "secure"] as const;
/** Modules whose import marks SvelteKit server code. */
const SVELTEKIT_MODULE = /^@sveltejs\/kit$|(?:^|\/)\$types$/;
const SVELTEKIT_SERVER_FILE =
  /(?:^|\/)(?:\+(?:page|layout)\.server|\+server|hooks\.server)\.[cm]?[jt]s$/;

type CookieFlag = (typeof COOKIE_FLAGS)[number];
/** A flag's literal value, or "dynamic" when code decides at runtime. */
type FlagValue = boolean | "dynamic" | "missing";

function isNone(node: Node | undefined): boolean {
  return Boolean(
    node &&
      (Node.isStringLiteral(node) ||
        Node.isNoSubstitutionTemplateLiteral(node)) &&
      node.getLiteralText().toLowerCase() === "none",
  );
}

/** True when an object literal sits inside a call such as jwt.sign(...). */
function isInJwtCall(node: Node): boolean {
  return Boolean(
    node.getFirstAncestor(
      (ancestor) =>
        (Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor)) &&
        JWT_CALLEE.test(ancestor.getExpression().getText()),
    ),
  );
}

function acceptsNoneAlgorithm(property: Node): boolean {
  if (!Node.isPropertyAssignment(property)) return false;
  const name = property.getName().replace(/["']/g, "");
  const value = property.getInitializer();
  if (name === "algorithms" && Node.isArrayLiteralExpression(value)) {
    return value.getElements().some(isNone);
  }
  return name === "algorithm" && isNone(value) && isInJwtCall(property);
}

function ignoresExpiration(property: Node): boolean {
  return (
    Node.isPropertyAssignment(property) &&
    property.getName().replace(/["']/g, "") === "ignoreExpiration" &&
    property.getInitializer()?.getKind() === SyntaxKind.TrueKeyword
  );
}

function flagValue(options: Node | undefined, flag: CookieFlag): FlagValue {
  if (!options) return "missing";
  if (!Node.isObjectLiteralExpression(options)) return "dynamic";
  // Spread options such as `{ ...defaults }` may set the flag.
  if (options.getProperties().some(Node.isSpreadAssignment)) return "dynamic";
  const value = objectProperty(options, [flag]);
  if (!value) return "missing";
  if (value.getKind() === SyntaxKind.TrueKeyword) return true;
  if (value.getKind() === SyntaxKind.FalseKeyword) return false;
  return "dynamic";
}

/** For `res.cookie(name, value, options)` and its equivalents: name and options. */
function cookieCall(
  call: CallExpression,
): { name: string; options: Node | undefined } | null {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return null;
  const method = expression.getName();
  const receiver = expression.getExpression().getText();
  const isCookieSetter =
    (method === "cookie" && RESPONSE_OBJECT.test(receiver)) ||
    method === "setCookie" ||
    (method === "set" && /(?:^|\.)cookies(?:\(\))?$/.test(receiver));
  if (!isCookieSetter) return null;

  const [name, , options] = call.getArguments();
  if (
    !name ||
    !(Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name))
  ) {
    return null;
  }
  return { name: name.getLiteralText(), options };
}

/**
 * SvelteKit's `cookies.set()`, whose httpOnly and secure options default to
 * true: a call on the request event's cookies in a SvelteKit module.
 */
function hasSecureDefaults(call: CallExpression, file: string): boolean {
  const expression = call.getExpression();
  return (
    Node.isPropertyAccessExpression(expression) &&
    /(?:^|\.)cookies$/.test(expression.getExpression().getText()) &&
    (SVELTEKIT_SERVER_FILE.test(file) ||
      call
        .getSourceFile()
        .getImportDeclarations()
        .some((declaration) =>
          SVELTEKIT_MODULE.test(declaration.getModuleSpecifierValue()),
        ))
  );
}

function insecureCookie(call: CallExpression, file: string) {
  const cookie = cookieCall(call);
  if (!cookie || !SENSITIVE_COOKIE.test(cookie.name)) return null;
  const defaults = hasSecureDefaults(call, file);
  const missing = COOKIE_FLAGS.filter((flag) => {
    const value = flagValue(cookie.options, flag);
    return value === false || (value === "missing" && !defaults);
  });
  if (missing.length === 0) return null;
  return {
    ...fromRule("insecure-cookie"),
    message: `Cookie "${cookie.name}" is set without ${missing.join(" and ")}`,
    file,
    line: call.getStartLineNumber(),
    fix: "Set httpOnly: true and secure: true (and a sameSite policy) on session and token cookies",
  } satisfies DiagnosticIssue;
}

/** Session middleware options: top-level flags and a nested `cookie` object. */
function sessionOptions(
  call: CallExpression,
  sessions: ReturnType<typeof moduleBindings>,
): ObjectLiteralExpression | null {
  const expression = call.getExpression();
  const args = call.getArguments();
  let options: Node | undefined;
  if (
    Node.isIdentifier(expression) &&
    sessions.namespaces.has(expression.getText())
  ) {
    options = args[0];
  } else if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getName() === "register" &&
    args[0] &&
    sessions.namespaces.has(args[0].getText())
  ) {
    options = args[1];
  }
  return options && Node.isObjectLiteralExpression(options) ? options : null;
}

function insecureSession(
  call: CallExpression,
  sessions: ReturnType<typeof moduleBindings>,
  file: string,
) {
  const options = sessionOptions(call, sessions);
  if (!options) return null;
  const cookie = objectProperty(options, ["cookie"]);
  const disabled = COOKIE_FLAGS.filter(
    (flag) =>
      flagValue(options, flag) === false ||
      (cookie !== null && flagValue(cookie, flag) === false),
  );
  if (disabled.length === 0) return null;
  return {
    ...fromRule("insecure-cookie"),
    message: `Session cookie options turn off ${disabled.join(" and ")}`,
    file,
    line: call.getStartLineNumber(),
    fix: "Keep httpOnly enabled and set secure: true in production (behind a proxy, also set trust proxy)",
  } satisfies DiagnosticIssue;
}

function unsecuredJwt(node: Node, file: string): DiagnosticIssue {
  return {
    ...fromRule("jwt-none-algorithm"),
    message: "jose UnsecuredJWT creates or reads tokens without a signature",
    file,
    line: node.getStartLineNumber(),
    fix: "Sign tokens with SignJWT and verify them with jwtVerify and an algorithm allowlist",
  };
}

/**
 * JWT and session misconfiguration: the `none` algorithm, ignored token
 * expiration, and session or token cookies that scripts can read or that are
 * sent over plain HTTP.
 */
export function inspectAuthConfiguration(
  sourceFile: SourceFile,
  file: string,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const sessions = moduleBindings(sourceFile, SESSION_MODULES, new Set());

  for (const object of sourceFile.getDescendantsOfKind(
    SyntaxKind.ObjectLiteralExpression,
  )) {
    for (const property of object.getProperties()) {
      if (acceptsNoneAlgorithm(property)) {
        issues.push({
          ...fromRule("jwt-none-algorithm"),
          message:
            'JWT options accept the "none" algorithm, so unsigned tokens are trusted',
          file,
          line: property.getStartLineNumber(),
          fix: "List only the signing algorithms you issue, such as ['RS256'] or ['HS256']",
        });
      }
      if (ignoresExpiration(property)) {
        issues.push({
          ...fromRule("jwt-expiration-ignored"),
          message: "JWT verification ignores the token's expiration time",
          file,
          line: property.getStartLineNumber(),
          fix: "Remove ignoreExpiration and issue short-lived tokens with a refresh flow",
        });
      }
    }
  }

  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    if (expression.getExpression().getText() === "UnsecuredJWT") {
      issues.push(unsecuredJwt(expression, file));
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    if (call.getExpression().getText() === "UnsecuredJWT.decode") {
      issues.push(unsecuredJwt(call, file));
      continue;
    }
    const finding =
      insecureCookie(call, file) ?? insecureSession(call, sessions, file);
    if (finding) issues.push(finding);
  }

  return issues.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
}
