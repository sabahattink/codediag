import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  analyzeSecurity,
  gitignoreProtectsEnv,
} from "../src/analyzers/security.js";

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
      const result = await analyzeSecurity(directory);
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
      const result = await analyzeSecurity(directory);
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
      const result = await analyzeSecurity(directory);
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
      const result = await analyzeSecurity(directory);
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
      const result = await analyzeSecurity(directory);
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
      const result = await analyzeSecurity(directory);
      const secretIssues = result.issues.filter(
        (issue) => issue.rule === "hardcoded-secret",
      );
      assert.equal(secretIssues.length, 1);
      assert.equal(secretIssues[0]?.line, 3);
    },
  );
});
