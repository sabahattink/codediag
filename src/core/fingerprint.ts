import { createHash } from "node:crypto";
import { getRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

export const FINGERPRINT_KEY = "codediagFinding/v2";

/** Collapses whitespace so indentation and formatting changes keep the key. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The location-independent part of a finding's identity: the flagged line's
 * normalized text when available, otherwise the message (fileless findings
 * such as audit counts are identified by what they report). Lines that may
 * hold a credential are never hashed.
 */
function anchor(issue: DiagnosticIssue, lineText: string | null): string {
  const sensitive = getRule(issue.rule)?.sensitiveSource === true;
  if (issue.line !== undefined && lineText !== null && !sensitive) {
    const normalized = normalize(lineText);
    if (normalized) return normalized;
  }
  return issue.file && issue.line === undefined ? "" : normalize(issue.message);
}

export function computeFingerprint(
  issue: DiagnosticIssue,
  lineText: string | null,
  occurrence = 0,
): string {
  return createHash("sha256")
    .update(
      [issue.rule, issue.file ?? "", anchor(issue, lineText), occurrence].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

/**
 * Adds a line-number-independent fingerprint to every issue. Identical
 * findings (same rule, file, and line text) are told apart by their order.
 */
export function assignFingerprints(
  results: AnalyzerResult[],
  readText: (file: string) => string | null,
): AnalyzerResult[] {
  const lineCache = new Map<string, string[] | null>();
  const occurrences = new Map<string, number>();

  const lineText = (issue: DiagnosticIssue): string | null => {
    if (!issue.file || issue.line === undefined) return null;
    if (!lineCache.has(issue.file)) {
      lineCache.set(issue.file, readText(issue.file)?.split(/\r?\n/) ?? null);
    }
    return lineCache.get(issue.file)?.[issue.line - 1] ?? null;
  };

  return results.map((result) => ({
    ...result,
    issues: result.issues.map((issue) => {
      const text = lineText(issue);
      const base = computeFingerprint(issue, text);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      return {
        ...issue,
        fingerprint:
          occurrence === 0 ? base : computeFingerprint(issue, text, occurrence),
      };
    }),
  }));
}
