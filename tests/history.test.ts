import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  historyPoint,
  loadHistory,
  MAX_HISTORY_POINTS,
  recordHistory,
  sparkline,
  withHistory,
} from "../src/core/history.js";
import type { ScanResult } from "../src/types.js";

function report(timestamp: string, totalScore: number): ScanResult {
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
      { name: "Security", score: totalScore, issues: [], summary: "" },
    ],
    totalScore,
    grade: totalScore >= 80 ? "B" : "D",
    timestamp,
  };
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-history-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("recorded reports load back oldest first, skipping anything else", () => {
  withDirectory((directory) => {
    recordHistory(directory, report("2026-10-02T09:00:00.000Z", 70));
    recordHistory(directory, report("2026-10-01T09:00:00.000Z", 62));
    writeFileSync(
      join(directory, "codediag-2026-10-03T09-00-00-000Z.json"),
      "{",
    );
    writeFileSync(join(directory, "notes.json"), JSON.stringify({ a: 1 }));

    assert.deepEqual(readdirSync(directory).sort(), [
      "codediag-2026-10-01T09-00-00-000Z.json",
      "codediag-2026-10-02T09-00-00-000Z.json",
      "codediag-2026-10-03T09-00-00-000Z.json",
      "notes.json",
    ]);
    assert.deepEqual(loadHistory(directory), [
      {
        timestamp: "2026-10-01T09:00:00.000Z",
        totalScore: 62,
        grade: "D",
        analyzers: { Security: 62 },
      },
      {
        timestamp: "2026-10-02T09:00:00.000Z",
        totalScore: 70,
        grade: "D",
        analyzers: { Security: 70 },
      },
    ]);
    assert.deepEqual(loadHistory(join(directory, "missing")), []);
  });
});

test("withHistory appends the current scan and keeps the newest points", () => {
  const earlier = Array.from({ length: MAX_HISTORY_POINTS + 5 }, (_, index) => {
    const point = historyPoint(
      report(
        `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        index,
      ),
    );
    assert.ok(point);
    return point;
  });
  const result = withHistory(report("2026-10-30T00:00:00.000Z", 88), earlier);

  assert.equal(result.history?.length, MAX_HISTORY_POINTS);
  assert.equal(result.history?.at(-1)?.totalScore, 88);
  assert.equal(result.history?.at(-1)?.timestamp, "2026-10-30T00:00:00.000Z");
});

test("historyPoint rejects documents that are not reports", () => {
  assert.equal(historyPoint(null), null);
  assert.equal(historyPoint({ timestamp: "x", totalScore: 1 }), null);
});

test("sparkline maps scores to eight block heights", () => {
  assert.equal(sparkline([0, 12.5, 50, 99, 100]), "▁▂▅██");
  assert.equal(sparkline([]), "");
});
