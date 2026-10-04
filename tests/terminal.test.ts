import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderTerminal } from "../src/reporters/terminal.js";
import type { ScanResult } from "../src/types.js";

function capture(run: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  // Strip ANSI colors so assertions read the visible text.
  return stripVTControlCharacters(lines.join("\n"));
}

const result: ScanResult = {
  project: "fixture",
  stack: {
    framework: "generic",
    language: "typescript",
    orm: null,
    hasDocker: false,
    hasEnvFile: false,
    hasPrisma: false,
    hasTests: false,
    packageManager: "npm",
  },
  analyzers: [
    {
      name: "Testing",
      score: 67,
      summary: "0 test files",
      issues: [
        { severity: "critical", rule: "no-test-files", message: "No tests" },
        {
          severity: "info",
          rule: "zero-test-ratio",
          message: "No test ratio",
          causedBy: "no-test-files",
        },
      ],
      scoreBreakdown: [{ rule: "no-test-files", count: 1, penalty: 25 }],
    },
  ],
  totalScore: 67,
  grade: "D",
  timestamp: "2026-01-01T00:00:00.000Z",
  scoringVersion: 2,
};

test("verbose terminal output lists points lost per rule and root causes", () => {
  const output = capture(() => renderTerminal(result, { verbose: true }));

  assert.match(output, /^\s+-25 {2}no-test-files ×1$/m);
  assert.match(
    output,
    /No test ratio \(caused by no-test-files\) \[zero-test-ratio\]/,
  );
});

test("default terminal output keeps the breakdown out of the summary", () => {
  const output = capture(() => renderTerminal(result));

  assert.doesNotMatch(output, /no-test-files ×1/);
});
