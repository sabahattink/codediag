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

test("terminal output shows the change since a previous scan and the scope", () => {
  const compared: ScanResult = {
    ...result,
    analyzers: [
      {
        ...result.analyzers[0],
        issues: [{ ...result.analyzers[0].issues[0], isNew: true }],
      },
    ],
    scope: { changedSince: "origin/main", files: 2, excludedFindings: 5 },
    comparison: {
      previousTimestamp: "2025-12-20T00:00:00.000Z",
      previousScore: 72,
      previousGrade: "C",
      scoreDelta: -5,
      analyzers: [{ name: "Testing", previous: 72, current: 67, delta: -5 }],
      newFindings: 1,
      fixedFindings: 1,
      fixed: [
        {
          analyzer: "Testing",
          rule: "low-test-ratio",
          severity: "warning",
          message: "Low test ratio",
        },
      ],
    },
  };

  const output = capture(() => renderTerminal(compared, { verbose: true }));

  assert.match(
    output,
    /Scope: {4}2 files changed since origin\/main \(5 findings elsewhere not scored\)/,
  );
  assert.match(
    output,
    /Change: {3}▼ −5 since 2025-12-20 \(72 → 67\) · 1 new · 1 fixed/,
  );
  assert.match(output, /Testing .* 67 −5$/m);
  assert.match(output, /✖ NEW No tests \[no-test-files\]/);
  assert.match(output, /✔ Low test ratio \[low-test-ratio\]/);
});

test("terminal output shows the score trend from recorded scans", () => {
  const output = capture(() =>
    renderTerminal({
      ...result,
      history: [
        {
          timestamp: "2025-12-01T00:00:00.000Z",
          totalScore: 40,
          grade: "F",
          analyzers: {},
        },
        {
          timestamp: "2025-12-02T00:00:00.000Z",
          totalScore: 55,
          grade: "F",
          analyzers: {},
        },
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          totalScore: 67,
          grade: "D",
          analyzers: {},
        },
      ],
    }),
  );

  assert.match(
    output,
    /Trend: {4}▄▅▆ {2}40 → 67 over 3 scans since 2025-12-01/,
  );
});
