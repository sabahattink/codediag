import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

const AUTH_RULES = new Set([
  "jwt-none-algorithm",
  "jwt-expiration-ignored",
  "insecure-cookie",
]);

/** Each auth finding as [rule, severity, trimmed source line, message]. */
async function findings(lines: string[], file = "src/auth.ts") {
  const directory = mkdtempSync(join(tmpdir(), "codediag-auth-"));
  try {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, file), lines.join("\n"));
    const issues = await analyzeSecuritySinks(createScanContext(directory));
    return issues
      .filter((issue) => AUTH_RULES.has(issue.rule))
      .map((issue) => [
        issue.rule,
        issue.severity,
        lines[(issue.line ?? 0) - 1].trim(),
        issue.message,
      ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("JWT verification or signing with the none algorithm is critical", async () => {
  assert.deepEqual(
    await findings([
      'import jwt from "jsonwebtoken";',
      'import { UnsecuredJWT } from "jose";',
      "export function verify(token: string, key: string) {",
      '  return jwt.verify(token, key, { algorithms: ["HS256", "none"] });',
      "}",
      "export function sign(payload: object) {",
      '  return jwt.sign(payload, "", { algorithm: "none" });',
      "}",
      "export const unsigned = new UnsecuredJWT({ sub: '1' }).encode();",
      "JwtModule.register({ verifyOptions: { algorithms: ['NONE'] } });",
    ]),
    [
      [
        "jwt-none-algorithm",
        "critical",
        'return jwt.verify(token, key, { algorithms: ["HS256", "none"] });',
        'JWT options accept the "none" algorithm, so unsigned tokens are trusted',
      ],
      [
        "jwt-none-algorithm",
        "critical",
        'return jwt.sign(payload, "", { algorithm: "none" });',
        'JWT options accept the "none" algorithm, so unsigned tokens are trusted',
      ],
      [
        "jwt-none-algorithm",
        "critical",
        "export const unsigned = new UnsecuredJWT({ sub: '1' }).encode();",
        "jose UnsecuredJWT creates or reads tokens without a signature",
      ],
      [
        "jwt-none-algorithm",
        "critical",
        "JwtModule.register({ verifyOptions: { algorithms: ['NONE'] } });",
        'JWT options accept the "none" algorithm, so unsigned tokens are trusted',
      ],
    ],
  );
});

test("signed algorithms and non-JWT algorithm options are not reported", async () => {
  assert.deepEqual(
    await findings([
      'jwt.verify(token, key, { algorithms: ["RS256"] });',
      'createHash({ algorithm: "sha256" });',
      'const compression = { algorithm: "none" };',
      "const settings = { algorithms: [] };",
    ]),
    [],
  );
});

test("ignoring JWT expiration is reported", async () => {
  assert.deepEqual(
    await findings([
      "jwt.verify(token, key, { ignoreExpiration: true });",
      "new JwtStrategy({ ignoreExpiration: false, secretOrKey: key }, verify);",
      "PassportStrategy(Strategy, { ignoreExpiration: !production });",
    ]),
    [
      [
        "jwt-expiration-ignored",
        "warning",
        "jwt.verify(token, key, { ignoreExpiration: true });",
        "JWT verification ignores the token's expiration time",
      ],
    ],
  );
});

test("session and auth cookies without httpOnly or secure are reported", async () => {
  assert.deepEqual(
    await findings([
      "export function login(req, res) {",
      '  res.cookie("session", token);',
      '  res.cookie("refresh_token", token, { httpOnly: true });',
      '  res.cookie("jwt", token, { httpOnly: false, secure: true });',
      '  res.cookie("auth", token, { httpOnly: true, secure: process.env.NODE_ENV === "production" });',
      '  res.cookie("theme", "dark");',
      '  reply.setCookie("sid", id, { httpOnly: true, secure: true });',
      '  cookies().set("accessToken", token, { secure: true });',
      "}",
    ]),
    [
      [
        "insecure-cookie",
        "warning",
        'res.cookie("session", token);',
        'Cookie "session" is set without httpOnly and secure',
      ],
      [
        "insecure-cookie",
        "warning",
        'res.cookie("refresh_token", token, { httpOnly: true });',
        'Cookie "refresh_token" is set without secure',
      ],
      [
        "insecure-cookie",
        "warning",
        'res.cookie("jwt", token, { httpOnly: false, secure: true });',
        'Cookie "jwt" is set without httpOnly',
      ],
      [
        "insecure-cookie",
        "warning",
        'cookies().set("accessToken", token, { secure: true });',
        'Cookie "accessToken" is set without httpOnly',
      ],
    ],
  );
});

test("session middleware that turns cookie flags off is reported", async () => {
  assert.deepEqual(
    await findings([
      'import session from "express-session";',
      'import cookieSession from "cookie-session";',
      "app.use(session({ secret, cookie: { secure: false, httpOnly: true } }));",
      "app.use(cookieSession({ name: 's', keys, httpOnly: false }));",
      "app.use(session({ secret, cookie: { secure: true } }));",
    ]),
    [
      [
        "insecure-cookie",
        "warning",
        "app.use(session({ secret, cookie: { secure: false, httpOnly: true } }));",
        "Session cookie options turn off secure",
      ],
      [
        "insecure-cookie",
        "warning",
        "app.use(cookieSession({ name: 's', keys, httpOnly: false }));",
        "Session cookie options turn off httpOnly",
      ],
    ],
  );
});

test("auth rules skip test files", async () => {
  assert.deepEqual(
    await findings(
      ['jwt.verify(token, key, { algorithms: ["none"] });'],
      "src/auth.test.ts",
    ),
    [],
  );
});
