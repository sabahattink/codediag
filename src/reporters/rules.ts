import chalk from "chalk";
import {
  type AnalyzerName,
  getRule,
  RULES,
  type RuleDefinition,
  ruleDocsUrl,
} from "../rules/registry.js";

const ANALYZER_ORDER: AnalyzerName[] = [
  "API Health",
  "Security",
  "Dependencies",
  "Testing",
  "Structure",
];

const SEVERITY_COLOR = {
  critical: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
} as const;

function entries(): Array<[string, RuleDefinition]> {
  return Object.entries(RULES) as Array<[string, RuleDefinition]>;
}

/** Every registered rule grouped by analyzer, for `codediag rules`. */
export function renderRuleList(): string {
  const lines: string[] = [""];
  for (const analyzer of ANALYZER_ORDER) {
    lines.push(chalk.bold(`  ${analyzer}`));
    for (const [id, rule] of entries()
      .filter(([, definition]) => definition.analyzer === analyzer)
      .sort(([left], [right]) => left.localeCompare(right))) {
      const severity = SEVERITY_COLOR[rule.defaultSeverity](
        rule.defaultSeverity.padEnd(8),
      );
      lines.push(`    ${id.padEnd(32)} ${severity} ${chalk.dim(rule.title)}`);
    }
    lines.push("");
  }
  lines.push(
    chalk.dim(
      "  Run codediag explain <rule> for details, or see docs/rules.md.",
    ),
    "",
  );
  return lines.join("\n");
}

export function ruleListJson(): string {
  return JSON.stringify(
    entries().map(([id, rule]) => ({ id, ...rule, docsUrl: ruleDocsUrl(id) })),
    null,
    2,
  );
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length];
}

/** Up to three registered rule IDs that look like a mistyped one. */
export function suggestRules(id: string): string[] {
  return entries()
    .map(([candidate]) => ({
      candidate,
      score: candidate.includes(id) ? 0 : distance(id, candidate),
    }))
    .filter(({ score }) => score <= Math.max(3, Math.floor(id.length / 3)))
    .sort((left, right) => left.score - right.score)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

/** Full description of one rule, for `codediag explain <rule>`. */
export function renderRuleExplanation(id: string): string | null {
  const rule = getRule(id);
  if (!rule) return null;
  const lines = [
    "",
    `  ${chalk.bold(id)} ${chalk.dim("—")} ${rule.title}`,
    "",
    `  ${chalk.dim("Analyzer:")} ${rule.analyzer}`,
    `  ${chalk.dim("Default severity:")} ${SEVERITY_COLOR[rule.defaultSeverity](rule.defaultSeverity)}`,
  ];
  if (rule.cwe?.length)
    lines.push(`  ${chalk.dim("CWE:")} ${rule.cwe.join(", ")}`);
  if (rule.owasp?.length) {
    lines.push(`  ${chalk.dim("OWASP Top 10:")} ${rule.owasp.join(", ")}`);
  }
  if (rule.rootCause) {
    lines.push(
      `  ${chalk.dim("Not penalized when reported with:")} ${rule.rootCause}`,
    );
  }
  if (rule.failsAnalyzer) {
    lines.push(`  ${chalk.dim("Scoring:")} sets the analyzer score to 0`);
  }
  lines.push(
    "",
    `  ${rule.description}`,
    "",
    chalk.dim("  Suppress one finding with a reason:"),
    `    // codediag-ignore-next-line ${id} -- <why this is acceptable>`,
    chalk.dim("  Change it for the whole project in .codediag.yml:"),
    `    rules:\n      ${id}: off   # or info, warning, critical`,
    "",
    `  ${chalk.dim(ruleDocsUrl(id))}`,
    "",
  );
  return lines.join("\n");
}
