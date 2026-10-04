import { type AnalyzerName, RULES, type RuleDefinition } from "./registry.js";

const ANALYZER_ORDER: AnalyzerName[] = [
  "API Health",
  "Security",
  "Dependencies",
  "Testing",
  "Structure",
];

function cweLink(id: string): string {
  const number = id.replace(/^CWE-/i, "");
  return `[${id}](https://cwe.mitre.org/data/definitions/${number}.html)`;
}

function ruleSection(id: string, rule: RuleDefinition): string[] {
  const lines = [
    `### ${id}`,
    "",
    `**${rule.title}** · default severity: \`${rule.defaultSeverity}\``,
    "",
    rule.description,
    "",
  ];
  if (rule.cwe?.length)
    lines.push(`- CWE: ${rule.cwe.map(cweLink).join(", ")}`);
  if (rule.owasp?.length)
    lines.push(`- OWASP Top 10: ${rule.owasp.join(", ")}`);
  if (rule.rootCause) {
    lines.push(`- Root cause: [\`${rule.rootCause}\`](#${rule.rootCause})`);
  }
  if (rule.failsAnalyzer) {
    lines.push("- Scoring: sets the analyzer score to 0 (nothing to evaluate)");
  }
  if (
    rule.cwe?.length ||
    rule.owasp?.length ||
    rule.rootCause ||
    rule.failsAnalyzer
  ) {
    lines.push("");
  }
  return lines;
}

/** Renders docs/rules.md from the rule registry. */
export function renderRulesMarkdown(): string {
  const entries = Object.entries(RULES) as Array<[string, RuleDefinition]>;
  const lines = [
    "# CodeDiag rules",
    "",
    "<!-- Generated from src/rules/registry.ts by `npm run docs:rules`. Do not edit by hand. -->",
    "",
    "Every finding carries one of these rule IDs. SARIF output links each rule",
    "to its section here through `helpUri`.",
    "",
    "With scoring version 2, a finding whose root cause is also reported is",
    "downgraded to `info`, marked with `causedBy`, and costs no points.",
    "",
  ];

  for (const analyzer of ANALYZER_ORDER) {
    const rules = entries
      .filter(([, rule]) => rule.analyzer === analyzer)
      .sort(([left], [right]) => left.localeCompare(right));
    lines.push(`## ${analyzer}`, "");
    for (const [id, rule] of rules) lines.push(...ruleSection(id, rule));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
