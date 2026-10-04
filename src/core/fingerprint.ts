import { createHash } from "node:crypto";
import { getRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

export const FINGERPRINT_KEY = "codediagFinding/v2";

/** Collapses whitespace so indentation and formatting changes keep the key. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The location-independent part of a finding's identity.
 *
 * - With a source line: the line's normalized text plus the message, so short
 *   lines such as `@Post()` are told apart by what the finding says. Lines
 *   that may hold a credential are never hashed.
 * - With a file but no line: nothing beyond the rule and file.
 * - Without a file: the message with numbers masked, so a changing count
 *   (such as a test ratio) keeps its identity, unless the rule declares that
 *   counts are identity (vulnerability totals).
 */
function anchor(issue: DiagnosticIssue, lineText: string | null): string {
  const rule = getRule(issue.rule);
  const message = normalize(issue.message);
  if (issue.line !== undefined) {
    const line = lineText === null ? "" : normalize(lineText);
    return rule?.sensitiveSource || !line ? message : `${line}\u0001${message}`;
  }
  if (issue.file) return "";
  return rule?.countsAreIdentity
    ? message
    : message.replace(/\d+(?:\.\d+)?/g, "#");
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
