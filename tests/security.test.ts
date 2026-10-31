import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  analyzeSecurity,
  gitignoreProtectsEnv,
} from "../src/analyzers/security.js";
import { isLikelySecretValue } from "../src/analyzers/secrets.js";
import { createScanContext } from "../src/core/scan-context.js";

function withProject(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-security-"));
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return run(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function rules(result: Awaited<ReturnType<typeof analyzeSecurity>>): string[] {
  return result.issues.map((issue) => issue.rule);
}

test("generic Node packages are not penalized for web middleware", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({
        name: "fixture",
        dependencies: { chalk: "^5.0.0" },
      }),
      "index.ts": "export const value = 1;\n",
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.equal(result.score, 100);
      assert.equal(rules(result).includes("no-helmet"), false);
      assert.equal(rules(result).includes("no-rate-limiting"), false);
    },
  );
});

test("gitignore matching rejects lookalikes and respects negation", () => {
  assert.equal(gitignoreProtectsEnv(".env.example\n"), false);
  assert.equal(gitignoreProtectsEnv("# .env\n"), false);
  assert.equal(gitignoreProtectsEnv(".env*\n!.env.example\n"), true);
  assert.equal(gitignoreProtectsEnv(".env\n!.env\n"), false);
});

test("middleware imports without runtime invocation do not pass", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({
        dependencies: {
          express: "latest",
          helmet: "latest",
          "express-rate-limit": "latest",
        },
      }),
      "server.ts": [
        'import helmet from "helmet";',
        'import limit from "express-rate-limit";',
        "// helmet(); limit();",
        "app.use(helmet);",
        "app.use(limit);",
        "export const app = {};",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.ok(rules(result).includes("no-helmet"));
      assert.ok(rules(result).includes("no-rate-limiting"));
    },
  );
});

test("configured middleware and secure password hashing pass", async () => {
  await withProject(
    {
      ".gitignore": ".env*\n!.env.example\n",
      "package.json": JSON.stringify({
        dependencies: {
          express: "latest",
          helmet: "latest",
          "express-rate-limit": "latest",
          cors: "latest",
          bcrypt: "latest",
        },
      }),
      "server.ts": [
        'import helmet from "helmet";',
        'import limit from "express-rate-limit";',
        'import cors from "cors";',
        "app.use(helmet());",
        "app.use(limit({ windowMs: 60_000, limit: 100 }));",
        'app.use(cors({ origin: "https://example.com" }));',
      ].join("\n"),
      "auth.ts": [
        'import bcrypt from "bcrypt";',
        "export async function createUser(password: string) {",
        "  const passwordHash = await bcrypt.hash(password, 12);",
        "  return database.user.create({ data: { passwordHash } });",
        "}",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.equal(result.score, 100);
      assert.deepEqual(result.issues, []);
    },
  );
});

test("open Express CORS reports its source location", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({
        dependencies: { express: "latest", cors: "latest" },
      }),
      "server.ts": [
        'import allowCrossOrigin from "cors";',
        "const app = express();",
        "app.use(allowCrossOrigin());",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      const issue = result.issues.find((entry) => entry.rule === "open-cors");
      assert.equal(issue?.file, "server.ts");
      assert.equal(issue?.line, 3);
    },
  );
});

test("unsafe password handling is reported without duplicate persistence noise", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({ name: "fixture" }),
      "auth.ts": [
        'import { createHash } from "node:crypto";',
        "export async function login(password: string, storedPassword: string) {",
        "  if (password === storedPassword) return true;",
        '  const passwordHash = createHash("sha1").update(password).digest("hex");',
        "  return database.user.create({ data: { passwordHash } });",
        "}",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.ok(rules(result).includes("weak-password-hash"));
      assert.ok(rules(result).includes("plaintext-password-comparison"));
      assert.equal(
        rules(result).includes("password-hashing-not-detected"),
        false,
      );
    },
  );
});

test("commented credentials are ignored while live tokens include a line", async () => {
  const fakeApiKey = "a".repeat(32);
  const githubToken = `ghp_${"b".repeat(36)}`;
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({ name: "fixture" }),
      "index.ts": [
        `// const apiKey = '${fakeApiKey}';`,
        "export const value = 1;",
        `export const githubToken = '${githubToken}';`,
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      const secretIssues = result.issues.filter(
        (issue) => issue.rule === "hardcoded-secret",
      );
      assert.equal(secretIssues.length, 1);
      assert.equal(secretIssues[0]?.line, 3);
    },
  );
});

test("runtime sink findings contribute to the security analyzer score", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({ name: "fixture" }),
      "src/handler.ts": [
        'import { exec } from "node:child_process";',
        "export function handler(req: any) {",
        "  return exec(req.query.command);",
        "}",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      const issue = result.issues.find(
        (entry) => entry.rule === "dynamic-command-execution",
      );

      assert.equal(issue?.severity, "critical");
      assert.equal(issue?.file, "src/handler.ts");
      assert.equal(issue?.line, 3);
      assert.ok(result.score < 100);
    },
  );
});

test("interpolated values are not hardcoded secrets", async () => {
  const literal = ["hunter2", "hunter2"].join("-");
  // "${" is assembled so this test file holds no template placeholders.
  const placeholder = (name: string) => ["$", "{", name, "}"].join("");
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": "{}",
      "src/config.ts": [
        `const login = \`password: "${placeholder("password")}"\`;`,
        `const dsn = \`secret = "${placeholder("prefix")}-${placeholder("suffix")}"\`;`,
        `const fallback = { password: "${literal}" };`,
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.deepEqual(
        result.issues
          .filter((issue) => issue.rule === "hardcoded-secret")
          .map((issue) => issue.line),
        [3],
      );
    },
  );
});

test("Hono servers need secure headers and a rate limiter, and cors() is open", async () => {
  const manifest = JSON.stringify({
    name: "hono-app",
    dependencies: { hono: "^4.6.0", "hono-rate-limiter": "^0.4.0" },
  });

  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": manifest,
      "src/app.ts": [
        'import { Hono } from "hono";',
        'import { cors as allowOrigins } from "hono/cors";',
        "const app = new Hono();",
        "app.use(allowOrigins());",
        "export default app;",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.deepEqual(
        rules(result).filter((rule) =>
          ["no-helmet", "no-rate-limiting", "open-cors"].includes(rule),
        ),
        ["no-helmet", "open-cors", "no-rate-limiting"],
      );
      assert.equal(
        result.issues.find((issue) => issue.rule === "open-cors")?.line,
        4,
      );
    },
  );

  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": manifest,
      "src/app.ts": [
        'import { Hono } from "hono";',
        'import { cors } from "hono/cors";',
        'import { secureHeaders } from "hono/secure-headers";',
        'import { rateLimiter } from "hono-rate-limiter";',
        "const app = new Hono();",
        "app.use(secureHeaders());",
        'app.use(cors({ origin: ["https://app.example.com"] }));',
        "app.use(rateLimiter({ windowMs: 60_000, limit: 100, keyGenerator: (c) => c.req.header('x-real-ip') ?? '' }));",
        "export default app;",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.deepEqual(
        rules(result).filter((rule) =>
          ["no-helmet", "no-rate-limiting", "open-cors"].includes(rule),
        ),
        [],
      );
    },
  );
});

test("password checks ignore validation, messages, and hashed nested writes", async () => {
  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({ name: "remix-app" }),
      "app/routes/join.tsx": [
        "export async function action({ request }) {",
        "  const formData = await request.formData();",
        '  const password = formData.get("password");',
        '  const confirmPassword = formData.get("confirmPassword");',
        '  if (typeof password !== "string" || password.length === 0) {',
        '    return json({ errors: { password: "Password is required" } }, { status: 400 });',
        "  }",
        "  if (password.length < 8) {",
        '    return json({ errors: { password: "Password is too short" } }, { status: 400 });',
        "  }",
        "  if (password !== confirmPassword) {",
        '    return json({ errors: { password: "Passwords do not match" } }, { status: 400 });',
        "  }",
        "  return createUser(password);",
        "}",
      ].join("\n"),
      "app/routes/settings.password.tsx": [
        'import { getPasswordHash } from "../utils/auth.server";',
        "export async function action({ request }) {",
        "  const { newPassword } = await parse(request);",
        "  await prisma.user.update({",
        "    where: { id: 1 },",
        "    data: { password: { update: { hash: await getPasswordHash(newPassword) } } },",
        "  });",
        "}",
      ].join("\n"),
      "app/routes/settings.profile.tsx": [
        "export async function loader() {",
        "  const password = await prisma.password.findUnique({ where: { userId: 1 } });",
        "  return { hasPassword: Boolean(password) };",
        "}",
        "export async function action() {",
        '  await prisma.user.update({ where: { id: 1 }, data: { name: "Ada" } });',
        "}",
      ].join("\n"),
      // The Pwned Passwords range API takes the first characters of a SHA-1.
      "app/utils/breach.server.ts": [
        'import crypto from "node:crypto";',
        "export async function isCommonPassword(password: string) {",
        '  const hash = crypto.createHash("sha1").update(password).digest("hex");',
        "  const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);",
        "  return (await response.text()).includes(hash.slice(5).toUpperCase());",
        "}",
      ].join("\n"),
      "app/utils/breach.server.test.ts": [
        "test('rejects breached passwords', async () => {",
        "  const password = 'sup3r-dup3r-s3cret';",
        "  expect(await isCommonPassword(password)).toBe(true);",
        "});",
      ].join("\n"),
      // Seeded users get their password from a helper that hashes it.
      "prisma/seed.ts": [
        'import { createPassword } from "../tests/db-utils";',
        "await prisma.user.create({",
        '  data: { username: "kody", password: { create: createPassword("kody") } },',
        "});",
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.deepEqual(
        result.issues.filter((issue) =>
          [
            "hardcoded-secret",
            "plaintext-password-comparison",
            "password-hashing-not-detected",
            "weak-password-hash",
          ].includes(issue.rule),
        ),
        [],
      );
    },
  );

  await withProject(
    {
      ".gitignore": ".env\n",
      "package.json": JSON.stringify({ name: "unsafe-app" }),
      "src/auth.ts": [
        "export async function login(email: string, password: string) {",
        "  const user = await db.user.findUnique({ where: { email } });",
        "  return user.password === password;",
        "}",
        "export function register(email: string, password: string) {",
        "  return db.user.create({ data: { email, password } });",
        "}",
        'const adminPassword = "Tr0ub4dor&3xyz";',
      ].join("\n"),
    },
    async (directory) => {
      const result = await analyzeSecurity(createScanContext(directory));
      assert.deepEqual(
        result.issues
          .filter((issue) =>
            [
              "hardcoded-secret",
              "plaintext-password-comparison",
              "password-hashing-not-detected",
            ].includes(issue.rule),
          )
          .map(({ rule, line }) => ({ rule, line })),
        [
          { rule: "hardcoded-secret", line: 8 },
          { rule: "plaintext-password-comparison", line: 3 },
          { rule: "password-hashing-not-detected", line: 6 },
        ],
      );
    },
  );
});

test("mock values in committed env examples are placeholders", () => {
  assert.equal(isLikelySecretValue("MOCK_GITHUB_CLIENT_SECRET"), false);
  assert.equal(isLikelySecretValue("mock-stripe-webhook-secret"), false);
  assert.equal(isLikelySecretValue("u8Fq2LmZp9XrT4vKw7Ys"), true);
});
