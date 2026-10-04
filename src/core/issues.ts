import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

/**
 * A finding that still needs attention: not suppressed in source and not part
 * of an accepted baseline. Only active findings affect scores, thresholds,
 * annotations, fix plans, and editor diagnostics.
 */
export function isActive(issue: DiagnosticIssue): boolean {
  return !issue.suppression && issue.baseline !== true;
}

export function activeIssues(analyzer: AnalyzerResult): DiagnosticIssue[] {
  return analyzer.issues.filter(isActive);
}

export interface InactiveCounts {
  suppressed: number;
  baseline: number;
}

export function inactiveCounts(analyzers: AnalyzerResult[]): InactiveCounts {
  const counts = { suppressed: 0, baseline: 0 };
  for (const analyzer of analyzers) {
    for (const issue of analyzer.issues) {
      if (issue.suppression) counts.suppressed += 1;
      else if (issue.baseline) counts.baseline += 1;
    }
  }
  return counts;
}
