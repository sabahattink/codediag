import type { DiagnosticIssue, ScanResult } from "../types.js";

const SEVERITY_ICON: Record<DiagnosticIssue["severity"], string> = {
  critical: "\u274C",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function scoreIcon(score: number): string {
  return score >= 80 ? "\u2705" : score >= 60 ? "\u26A0\uFE0F" : "\u274C";
}

/** Escapes text so it cannot break a table cell or inline formatting. */
function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/([*_`<>[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

function location(issue: DiagnosticIssue): string {
  if (!issue.file) return "";
  const where = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  return ` \u2014 \`${where.replace(/`/g, "'")}\``;
}

export function renderMarkdown(result: ScanResult, options: { verbose?: boolean } = {}): string {
  const stackLabel = [result.stack.framework, result.stack.language, result.stack.orm].filter(Boolean).join(" + ");
  const lines = [
    `## codediag \u2014 Diagnostic Report`,
    ``,
    `**Project:** ${escapeMarkdown(result.project)} \u00B7 **Stack:** ${escapeMarkdown(stackLabel)} \u00B7 **Score:** ${result.totalScore}/100 (${result.grade})`,
    ``,
    `| Analyzer | Score | Summary |`,
    `|----------|------:|---------|`,
  ];

  for (const a of result.analyzers) {
    lines.push(`| ${scoreIcon(a.score)} ${escapeMarkdown(a.name)} | ${a.score}/100 | ${escapeMarkdown(a.summary)} |`);
  }
  lines.push(`| **Total** | **${result.totalScore}/100 (${result.grade})** | |`);

  const all = result.analyzers.flatMap((a) => a.issues);
  const count = (s: DiagnosticIssue["severity"]): number => all.filter((i) => i.severity === s).length;
  const shown = all
    .filter((i) => options.verbose || i.severity !== "info")
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (all.length > 0) {
    lines.push(``, `### Issues (${count("critical")} critical \u00B7 ${count("warning")} warnings \u00B7 ${count("info")} info)`, ``);
    for (const issue of shown) {
      lines.push(`- ${SEVERITY_ICON[issue.severity]} ${escapeMarkdown(issue.message)}${location(issue)}`);
    }
    const hidden = all.length - shown.length;
    if (hidden > 0) lines.push(``, `_${hidden} info issues hidden (use --verbose)._`);
  }

  lines.push(``, `> Scanned by [codediag](https://codediag.dev) on ${result.timestamp.slice(0, 10)}`);
  return lines.join("\n");
}

function severityRank(severity: DiagnosticIssue["severity"]): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}
