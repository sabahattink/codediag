import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";

async function scan(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-sinks-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return await analyzeSecuritySinks(directory, [
      "node_modules/**",
      "dist/**",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("reports eval and Function constructor with source locations", async () => {
  const issues = await scan({
    "src/runtime.ts": [
      "export function run(source: string) {",
      "  eval(source);",
      '  return new Function("value", source);',
      "}",
    ].join("\n"),
  });

  assert.deepEqual(
    issues.map(({ rule, file, line }) => ({ rule, file, line })),
    [
      { rule: "unsafe-dynamic-code", file: "src/runtime.ts", line: 2 },
      { rule: "unsafe-dynamic-code", file: "src/runtime.ts", line: 3 },
    ],
  );
});

test("reports aliased ESM and CommonJS dynamic shell commands", async () => {
  const issues = await scan({
    "src/esm.ts": [
      'import { exec as run } from "node:child_process";',
      "export const handler = (req: any) => run(req.query.cmd);",
    ].join("\n"),
    "src/common.cjs": [
      'const cp = require("child_process");',
      "cp.execSync(command);",
      'require("node:child_process").exec(process.argv[2]);',
    ].join("\n"),
    "src/safe.ts": [
      'import { exec } from "node:child_process";',
      'exec("node --version");',
    ].join("\n"),
  });

  const commands = issues.filter(
    (issue) => issue.rule === "dynamic-command-execution",
  );
  assert.equal(commands.length, 3);
  assert.deepEqual(
    commands
      .map(({ file, line, severity }) => ({ file, line, severity }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: "src/common.cjs", line: 2, severity: "warning" },
      { file: "src/common.cjs", line: 3, severity: "critical" },
      { file: "src/esm.ts", line: 2, severity: "critical" },
    ],
  );
});

test("reports dynamic SQL but accepts literals and tagged templates", async () => {
  const issues = await scan({
    "src/database.ts": [
      "export async function lookup(db: any, req: any, id: string) {",
      "  await db.query(`SELECT * FROM users WHERE id = $" +
        "{req.query.id}`);",
      '  await db.query("SELECT * FROM users WHERE id = ?", [id]);',
      "  await db.$queryRaw`SELECT * FROM users WHERE id = $" + "{id}`;",
      "  await db.$queryRawUnsafe(req.body.query);",
      "  const sql = buildReportQuery(id);",
      "  await db.query(sql);",
      "  await cache.query(sql);",
      "}",
    ].join("\n"),
  });

  const sqlIssues = issues.filter(
    (issue) => issue.rule === "dynamic-sql-query",
  );
  assert.equal(sqlIssues.length, 3);
  assert.deepEqual(
    sqlIssues.map(({ line, severity }) => ({ line, severity })),
    [
      { line: 2, severity: "critical" },
      { line: 5, severity: "critical" },
      { line: 7, severity: "warning" },
    ],
  );
});

test("reports local and global TLS verification bypasses", async () => {
  const issues = await scan({
    "src/tls.ts": [
      "const agent = new https.Agent({ rejectUnauthorized: false });",
      'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";',
      'const childEnv = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };',
      "export { agent, childEnv };",
    ].join("\n"),
  });

  const tlsIssues = issues.filter(
    (issue) => issue.rule === "tls-verification-disabled",
  );
  assert.deepEqual(
    tlsIssues.map(({ line }) => line).sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test("excludes test fixtures and accepts safe runtime code", async () => {
  const issues = await scan({
    "src/service.ts": [
      'import { execFile } from "node:child_process";',
      'execFile("git", ["status", "--short"]);',
      "const agent = new https.Agent({ rejectUnauthorized: true });",
      'db.query("SELECT 1");',
    ].join("\n"),
    "tests/unsafe.test.ts": "eval(userInput);",
  });

  assert.deepEqual(issues, []);
});
