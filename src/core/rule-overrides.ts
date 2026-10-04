import type { AnalyzerResult, RuleSetting } from "../types.js";

/**
 * Applies `rules` from .codediag.yml: "off" removes a rule's findings and a
 * severity replaces the analyzer's severity for every finding of that rule.
 */
export function applyRuleOverrides(
  results: AnalyzerResult[],
  rules: Readonly<Record<string, RuleSetting>>,
): AnalyzerResult[] {
  if (Object.keys(rules).length === 0) return results;

  return results.map((result) => ({
    ...result,
    issues: result.issues.flatMap((issue) => {
      const setting = Object.hasOwn(rules, issue.rule)
        ? rules[issue.rule]
        : undefined;
      if (setting === undefined) return [issue];
      if (setting === "off") return [];
      return [{ ...issue, severity: setting }];
    }),
  }));
}
