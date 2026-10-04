import { readFileSync } from "node:fs";
import type { AnalyzerResult, BaselineSummary } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the finding fingerprints from a CodeDiag JSON report. Any report
 * written with `--format json`, `--ci`, or `--update-baseline` works.
 */
export function loadBaseline(path: string): Set<string> {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Cannot read baseline ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(document) || !Array.isArray(document.analyzers)) {
    throw new Error(
      `Baseline ${path} is not a CodeDiag JSON report (missing analyzers)`,
    );
  }

  const fingerprints = new Set<string>();
  for (const analyzer of document.analyzers) {
    if (!isRecord(analyzer) || !Array.isArray(analyzer.issues)) continue;
    for (const issue of analyzer.issues) {
      if (isRecord(issue) && typeof issue.fingerprint === "string") {
        fingerprints.add(issue.fingerprint);
      }
    }
  }
  return fingerprints;
}

/** Marks findings whose fingerprint is in the baseline as `baseline: true`. */
export function applyBaseline(
  results: AnalyzerResult[],
  baseline: ReadonlySet<string>,
): { results: AnalyzerResult[]; summary: BaselineSummary } {
  const matched = new Set<string>();
  const marked = results.map((result) => ({
    ...result,
    issues: result.issues.map((issue) => {
      if (!issue.fingerprint || !baseline.has(issue.fingerprint)) return issue;
      matched.add(issue.fingerprint);
      return { ...issue, baseline: true };
    }),
  }));

  return {
    results: marked,
    summary: {
      matched: matched.size,
      // Baseline findings that no longer occur have been fixed.
      fixed: baseline.size - matched.size,
    },
  };
}
