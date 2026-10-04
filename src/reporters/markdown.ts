import { activeIssues, inactiveCounts } from "../core/issues.js";
import { formatPenalty } from "../core/scoring.js";
import type { ScanResult } from "../types.js";

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

/** A compact report for pull request comments and job summaries. */
export function renderMarkdown(result: ScanResult): string {
  const lines = [
    `## codediag — Diagnostic Report`,
    ``,
    `| Metric | Score |`,
    `|--------|-------|`,
  ];

  for (const a of result.analyzers) {
    const icon = a.score >= 80 ? "✅" : a.score >= 60 ? "⚠️" : "❌";
    lines.push(`| ${icon} ${escapeCell(a.name)} | ${a.score}/100 |`);
  }

  lines.push(`| **Total** | **${result.totalScore}/100 (${result.grade})** |`);
  lines.push(``);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const analyzer of result.analyzers) {
    for (const issue of activeIssues(analyzer)) counts[issue.severity] += 1;
  }
  const inactive = inactiveCounts(result.analyzers);
  const notCounted = [
    inactive.suppressed > 0 ? `${inactive.suppressed} suppressed` : "",
    inactive.baseline > 0 ? `${inactive.baseline} in baseline` : "",
  ].filter(Boolean);
  lines.push(
    `**Findings:** ${counts.critical} critical · ${counts.warning} warning · ${counts.info} info${
      notCounted.length > 0 ? ` (not counted: ${notCounted.join(", ")})` : ""
    }`,
    ``,
  );

  const breakdown = result.analyzers.flatMap((a) =>
    (a.scoreBreakdown ?? []).map((entry) => ({ analyzer: a.name, ...entry })),
  );
  if (breakdown.length > 0) {
    lines.push(`### Score breakdown`, ``);
    lines.push(`| Analyzer | Rule | Findings | Points lost |`);
    lines.push(`|----------|------|---------:|------------:|`);
    for (const entry of breakdown) {
      lines.push(
        `| ${escapeCell(entry.analyzer)} | \`${entry.rule}\` | ${entry.count} | ${formatPenalty(entry.penalty)} |`,
      );
    }
    lines.push(``);
  }
  lines.push(
    `> Scanned by [codediag](https://github.com/sabahattink/codediag) on ${result.timestamp.slice(0, 10)}`,
  );

  return lines.join("\n");
}
