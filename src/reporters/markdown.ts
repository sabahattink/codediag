import { formatDelta } from "../core/compare.js";
import { activeIssues, inactiveCounts } from "../core/issues.js";
import { formatPenalty } from "../core/scoring.js";
import type { ComparisonSummary, ScanResult } from "../types.js";

const MAX_LISTED_FIXED = 25;

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function comparisonSection(
  comparison: ComparisonSummary,
  score: number,
): string[] {
  const lines = [
    `### Changes since ${comparison.previousTimestamp.slice(0, 10)}`,
    ``,
    `Score ${comparison.previousScore} → ${score} (**${formatDelta(comparison.scoreDelta)}**) · ${comparison.newFindings} new · ${comparison.fixedFindings} fixed`,
    ``,
    `| Analyzer | Before | Now | Change |`,
    `|----------|-------:|----:|-------:|`,
    ...comparison.analyzers.map(
      (entry) =>
        `| ${escapeCell(entry.name)} | ${entry.previous ?? "—"} | ${entry.current ?? "—"} | ${entry.delta === null ? "—" : formatDelta(entry.delta)} |`,
    ),
    ``,
  ];
  if (comparison.fixed.length > 0) {
    lines.push(`**Fixed:**`, ``);
    for (const finding of comparison.fixed.slice(0, MAX_LISTED_FIXED)) {
      const location = finding.file
        ? ` (\`${finding.line ? `${finding.file}:${finding.line}` : finding.file}\`)`
        : "";
      lines.push(
        `- ✅ ${escapeCell(finding.message)} \`${finding.rule}\`${location}`,
      );
    }
    if (comparison.fixed.length > MAX_LISTED_FIXED) {
      lines.push(`- …and ${comparison.fixed.length - MAX_LISTED_FIXED} more`);
    }
    lines.push(``);
  }
  return lines;
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
  if (result.scope) {
    lines.push(
      `> Scoped to ${result.scope.files} file${result.scope.files === 1 ? "" : "s"} changed since \`${result.scope.changedSince}\`; ${result.scope.excludedFindings} finding${result.scope.excludedFindings === 1 ? "" : "s"} elsewhere were not scored.`,
      ``,
    );
  }
  if (result.comparison) {
    lines.push(...comparisonSection(result.comparison, result.totalScore));
  }
  if (result.workspace) {
    lines.push(
      `### Packages (${result.workspace.tool} workspace)`,
      ``,
      `| Package | Framework | Score | Findings |`,
      `|---------|-----------|------:|---------:|`,
      ...result.workspace.packages.map(
        (entry) =>
          `| \`${escapeCell(entry.path)}\`${entry.name ? ` ${escapeCell(entry.name)}` : ""} | ${entry.framework} | ${entry.totalScore} (${entry.grade}) | ${entry.findings} |`,
      ),
      ``,
    );
  }

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
