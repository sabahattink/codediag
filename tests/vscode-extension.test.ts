import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectEditorDiagnostics,
  countSeverities,
} from "../extensions/vscode/src/core.js";
import type { ScanResult } from "../src/types.js";

function fixture(): ScanResult {
  return {
    project: "workspace",
    stack: {
      framework: "express",
      language: "typescript",
      orm: null,
      hasDocker: false,
      hasEnvFile: false,
      hasPrisma: false,
      hasTests: true,
      packageManager: "npm",
    },
    analyzers: [
      {
        name: "Security",
        score: 60,
        summary: "Review required",
        issues: [
          {
            severity: "critical",
            rule: "hardcoded-secret",
            message: "Potential secret",
            file: "src/config.ts",
            line: 8,
            fix: "Use an environment variable",
          },
          {
            severity: "warning",
            rule: "outside-workspace",
            message: "Unsafe path fixture",
            file: "../outside.ts",
          },
          {
            severity: "info",
            rule: "fileless",
            message: "Project-level finding",
          },
        ],
      },
      {
        name: "Testing",
        score: 80,
        summary: "One finding",
        issues: [
          {
            severity: "warning",
            rule: "coverage",
            message: "Coverage is low",
            file: "coverage/summary.json",
          },
        ],
      },
    ],
    totalScore: 70,
    grade: "C",
    timestamp: "2026-07-17T00:00:00.000Z",
  };
}

test("editor diagnostics preserve findings inside the workspace", () => {
  const root = resolve("workspace-fixture");
  const summary = collectEditorDiagnostics(fixture(), root);

  assert.equal(summary.diagnostics.length, 2);
  assert.equal(summary.fileless, 1);
  assert.equal(summary.outsideWorkspace, 1);
  assert.deepEqual(summary.diagnostics[0], {
    analyzer: "Security",
    severity: "critical",
    rule: "hardcoded-secret",
    message: "Potential secret",
    filePath: join(root, "src", "config.ts"),
    line: 7,
    fix: "Use an environment variable",
  });
  assert.equal(summary.diagnostics[1]?.line, 0);
});

test("absolute paths outside the workspace are rejected", () => {
  const root = resolve("workspace-fixture");
  const result = fixture();
  const issue = result.analyzers[0]?.issues[0];
  assert.ok(issue);
  issue.file = resolve(root, "..", "outside.ts");

  const summary = collectEditorDiagnostics(result, root);
  assert.equal(summary.outsideWorkspace, 2);
  assert.equal(summary.diagnostics.length, 1);
});

test("severity counts include located and project-level findings", () => {
  assert.deepEqual(countSeverities(fixture()), {
    critical: 1,
    warning: 2,
    info: 1,
  });
});
