import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { isActive } from "../src/core/issues.js";
import { scan } from "../src/scanner.js";
import type { DiagnosticIssue, ScanResult } from "../src/types.js";

/**
 * Regression net for analyzer changes: realistic, well-built projects must
 * keep a high score with no critical findings, and known-bad projects must
 * keep producing the findings they were written to trigger.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");

async function scanFixture(name: string): Promise<ScanResult> {
  const directory = join(FIXTURES, name);
  const config = loadConfig(directory);
  // Dependency audits need the network; every other analyzer runs offline.
  config.analyzers.dependencies = false;
  return scan(directory, config, { interactive: false });
}

function findings(result: ScanResult): DiagnosticIssue[] {
  return result.analyzers.flatMap((analyzer) =>
    analyzer.issues.filter(isActive),
  );
}

function describe(result: ScanResult): string {
  return findings(result)
    .map((issue) => `${issue.severity} ${issue.rule}: ${issue.message}`)
    .join("\n");
}

for (const [name, framework] of [
  ["realistic/nestjs", "nestjs"],
  ["realistic/express", "express"],
  ["realistic/nextjs", "nextjs"],
] as const) {
  test(`${name} scores at least 85 with no critical findings`, async () => {
    const result = await scanFixture(name);

    assert.equal(result.stack.framework, framework);
    assert.ok(result.totalScore >= 85, describe(result));
    assert.deepEqual(
      findings(result).filter((issue) => issue.severity === "critical"),
      [],
    );
    assert.equal(
      result.analyzers.some((analyzer) => analyzer.name === "API Health"),
      true,
    );
  });
}

test("defects/express keeps its routing, injection, and web sink findings", async () => {
  const result = await scanFixture("defects/express");
  const located = findings(result)
    .filter((issue) => issue.file === "src/app.js")
    .map(({ rule, severity, line, message }) => ({
      rule,
      severity,
      line,
      message,
    }));

  assert.deepEqual(located, [
    {
      rule: "missing-auth-middleware",
      severity: "warning",
      line: 7,
      message: "DELETE /admin/users/:id has no recognizable auth middleware",
    },
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      line: 11,
      message: "Shell execution receives a non-literal command",
    },
    {
      rule: "dynamic-sql-query",
      severity: "critical",
      line: 17,
      message: "SQL execution uses a dynamically constructed query",
    },
    {
      rule: "path-traversal",
      severity: "critical",
      line: 23,
      message: "A file path is built from request data",
    },
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      line: 27,
      message: "An outgoing HTTP request uses a URL chosen by request data",
    },
    {
      rule: "open-redirect",
      severity: "warning",
      line: 32,
      message: "A redirect target comes from request data",
    },
    {
      rule: "reflected-xss",
      severity: "critical",
      line: 36,
      message: "Request data is written into an HTML response without escaping",
    },
  ]);
});

test("defects/nestjs honors the global guard and flags the untyped body", async () => {
  const result = await scanFixture("defects/nestjs");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.deepEqual(
    api?.issues.map((issue) => issue.message),
    [
      "POST /users uses Record<string, any> for its request body; declare a DTO class",
    ],
  );
});
