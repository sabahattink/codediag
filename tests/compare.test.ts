import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareWithPrevious,
  formatDelta,
  loadReport,
  type PreviousReport,
} from "../src/core/compare.js";
import type { DiagnosticIssue, ScanResult } from "../src/types.js";

function issue(
  fingerprint: string,
  overrides: Partial<DiagnosticIssue> = {},
): DiagnosticIssue {
  return {
    severity: "warning",
    rule: "open-cors",
    message: `Finding ${fingerprint}`,
    file: "src/app.ts",
    line: 3,
    fingerprint,
    ...overrides,
  };
}

function result(
  security: DiagnosticIssue[],
  totalScore = 80,
  testing = 90,
): ScanResult {
  return {
    project: "demo",
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
      { name: "Security", score: totalScore, issues: security, summary: "" },
      { name: "Testing", score: testing, issues: [], summary: "" },
    ],
    totalScore,
    grade: "B",
    timestamp: "2026-10-29T10:00:00.000Z",
  };
}

function previous(
  security: DiagnosticIssue[],
  totalScore: number,
): PreviousReport {
  return {
    timestamp: "2026-10-20T10:00:00.000Z",
    totalScore,
    grade: "C",
    analyzers: [
      { name: "Security", score: totalScore, issues: security },
      { name: "Structure", score: 100, issues: [] },
    ],
  };
}

test("findings missing from the previous report are new; missing ones are fixed", () => {
  const compared = compareWithPrevious(
    result([issue("a"), issue("b"), issue("c", { baseline: true })], 84),
    previous(
      [issue("a"), issue("old", { severity: "critical", line: 9 })],
      72.5,
    ),
  );

  assert.deepEqual(
    compared.analyzers[0]?.issues.map((finding) => [
      finding.fingerprint,
      finding.isNew === true,
    ]),
    [
      ["a", false],
      ["b", true],
      ["c", false],
    ],
  );
  assert.deepEqual(compared.comparison, {
    previousTimestamp: "2026-10-20T10:00:00.000Z",
    previousScore: 72.5,
    previousGrade: "C",
    scoreDelta: 11.5,
    analyzers: [
      { name: "Security", previous: 72.5, current: 84, delta: 11.5 },
      { name: "Testing", previous: null, current: 90, delta: null },
      { name: "Structure", previous: 100, current: null, delta: null },
    ],
    newFindings: 1,
    fixedFindings: 1,
    fixed: [
      {
        analyzer: "Security",
        rule: "open-cors",
        severity: "critical",
        message: "Finding old",
        file: "src/app.ts",
        line: 9,
      },
    ],
  });
});

test("suppressed or baselined earlier findings are neither fixed nor matched", () => {
  const compared = compareWithPrevious(
    result([issue("s")]),
    previous(
      [
        issue("s", { suppression: { kind: "inSource", justification: "ok" } }),
        issue("gone", { baseline: true }),
      ],
      80,
    ),
  );
  assert.equal(compared.comparison?.newFindings, 1);
  assert.equal(compared.comparison?.fixedFindings, 0);
});

test("a scoped comparison only counts earlier findings in scope as fixed", () => {
  const compared = compareWithPrevious(
    result([]),
    previous(
      [
        issue("in", { file: "src/changed.ts" }),
        issue("out", { file: "src/other.ts" }),
        issue("project", { file: undefined, line: undefined }),
      ],
      70,
    ),
    new Set(["src/changed.ts"]),
  );
  assert.deepEqual(
    compared.comparison?.fixed.map((finding) => finding.file),
    ["src/changed.ts"],
  );
});

test("loadReport reads a JSON report and rejects anything else", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-compare-"));
  try {
    const valid = join(directory, "valid.json");
    writeFileSync(valid, JSON.stringify(result([issue("a")])));
    const report = loadReport(valid);
    assert.equal(report.totalScore, 80);
    assert.equal(report.analyzers[0]?.issues[0]?.fingerprint, "a");

    const notJson = join(directory, "broken.json");
    writeFileSync(notJson, "{");
    assert.throws(() => loadReport(notJson), /Cannot read report/);

    const notReport = join(directory, "other.json");
    writeFileSync(notReport, JSON.stringify({ analyzers: [] }));
    assert.throws(() => loadReport(notReport), /not a CodeDiag JSON report/);

    const legacy = join(directory, "legacy.json");
    writeFileSync(
      legacy,
      JSON.stringify(result([issue("a", { fingerprint: undefined })])),
    );
    assert.throws(() => loadReport(legacy), /no finding fingerprints/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formatDelta signs changes with true minus and plus-minus signs", () => {
  assert.equal(formatDelta(4.5), "+4.5");
  assert.equal(formatDelta(-3), "−3");
  assert.equal(formatDelta(0), "±0");
});
