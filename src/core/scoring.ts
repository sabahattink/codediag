import { getRule } from "../rules/registry.js";
import { isActive } from "./issues.js";
import type {
  AnalyzerResult,
  DiagnosticIssue,
  ScoreBreakdownEntry,
  ScoringVersion,
} from "../types.js";

export const SEVERITY_WEIGHTS: Record<DiagnosticIssue["severity"], number> = {
  critical: 25,
  warning: 8,
  info: 2,
};

/**
 * Each further finding of the same rule costs half the previous one, so one
 * rule can cost at most twice its highest severity weight.
 */
const REPEAT_DECAY = 0.5;

/** Points lost, as shown in reports: "-8", "-12.5". */
export function formatPenalty(penalty: number): string {
  return `-${penalty}`;
}

function roundPenalty(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Downgrades findings whose registered root cause is also reported to `info`
 * and links them with `causedBy`, so one problem is penalized once.
 */
function linkRootCauses(results: AnalyzerResult[]): AnalyzerResult[] {
  const reported = new Set(
    results.flatMap((result) => result.issues.map((issue) => issue.rule)),
  );

  return results.map((result) => ({
    ...result,
    issues: result.issues.map((issue) => {
      const rootCause = getRule(issue.rule)?.rootCause;
      if (!rootCause || !reported.has(rootCause)) return issue;
      return { ...issue, severity: "info", causedBy: rootCause };
    }),
  }));
}

function scoreIssues(issues: DiagnosticIssue[]): {
  score: number;
  scoreBreakdown: ScoreBreakdownEntry[];
} {
  const byRule = new Map<string, DiagnosticIssue[]>();
  for (const issue of issues) {
    if (issue.causedBy || !isActive(issue)) continue;
    byRule.set(issue.rule, [...(byRule.get(issue.rule) ?? []), issue]);
  }

  let total = 0;
  const scoreBreakdown: ScoreBreakdownEntry[] = [];
  for (const [rule, findings] of byRule) {
    const penalty = getRule(rule)?.failsAnalyzer
      ? 100
      : findings
          .map((finding) => SEVERITY_WEIGHTS[finding.severity])
          .sort((left, right) => right - left)
          .reduce(
            (sum, weight, index) => sum + weight * REPEAT_DECAY ** index,
            0,
          );
    total += penalty;
    scoreBreakdown.push({
      rule,
      count: findings.length,
      penalty: roundPenalty(penalty),
    });
  }

  scoreBreakdown.sort(
    (left, right) =>
      right.penalty - left.penalty || left.rule.localeCompare(right.rule),
  );

  return {
    score: Math.max(0, Math.round(100 - total)),
    scoreBreakdown,
  };
}

/**
 * Version 1 keeps each analyzer's own checks-passed score. Version 2 starts
 * every analyzer at 100 and subtracts a severity-weighted penalty per finding.
 */
export function applyScoring(
  results: AnalyzerResult[],
  version: ScoringVersion,
): AnalyzerResult[] {
  if (version === 1) return results;

  return linkRootCauses(results).map((result) => ({
    ...result,
    ...scoreIssues(result.issues),
  }));
}
