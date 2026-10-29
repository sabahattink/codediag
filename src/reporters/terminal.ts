import chalk from "chalk";
import type { DiagnosticIssue, ScanResult } from "../types.js";

const MAX_ISSUES_DEFAULT = 10;

function scoreBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  return color("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return chalk.green.bold(grade);
  if (grade.startsWith("B")) return chalk.cyan.bold(grade);
  if (grade.startsWith("C")) return chalk.yellow.bold(grade);
  if (grade.startsWith("D")) return chalk.hex("#FFA500").bold(grade);
  return chalk.red.bold(grade);
}

function severityIcon(severity: DiagnosticIssue["severity"]): string {
  switch (severity) {
    case "critical": return chalk.red("✖");
    case "warning": return chalk.yellow("⚠");
    case "info": return chalk.blue("ℹ");
  }
}

function issueLines(issue: DiagnosticIssue): string[] {
  const lines = [`  ${severityIcon(issue.severity)} ${issue.message}`];
  if (issue.file) lines.push(chalk.dim(`    ${issue.line ? `${issue.file}:${issue.line}` : issue.file}`));
  if (issue.fix) lines.push(chalk.dim(`    → ${issue.fix}`));
  return lines;
}

/** Renders the human-readable report. Returns text; the caller decides where it goes. */
export function renderTerminal(result: ScanResult, options: { quiet?: boolean; verbose?: boolean } = {}): string {
  const out: string[] = [""];

  if (options.quiet) {
    const color = result.totalScore >= 80 ? chalk.green : result.totalScore >= 60 ? chalk.yellow : chalk.red;
    out.push(`  ${chalk.bold("codediag")} ${color(result.totalScore + "/100")} ${gradeColor(result.grade)}`, "");
    return out.join("\n");
  }

  out.push(chalk.bold("  codediag") + chalk.dim(" — Diagnostic Report"), "");

  const stackLabel = [result.stack.framework, result.stack.language, result.stack.orm].filter(Boolean).join(chalk.dim(" + "));
  out.push(chalk.dim("  Project:  ") + chalk.white(result.project));
  out.push(chalk.dim("  Stack:    ") + stackLabel);
  out.push(chalk.dim("  Score:    ") + gradeColor(result.grade) + chalk.dim(` (${result.totalScore}/100)`), "");

  for (const a of result.analyzers) {
    out.push(`  ${chalk.dim(a.name.padEnd(16))} ${scoreBar(a.score)} ${chalk.bold(String(a.score).padStart(3))}`);
  }
  out.push("");

  const all = result.analyzers.flatMap((a) => a.issues);
  const criticals = all.filter((i) => i.severity === "critical");
  const warnings = all.filter((i) => i.severity === "warning");
  const infos = all.filter((i) => i.severity === "info");

  if (all.length === 0) {
    out.push(chalk.green("  ✔ No issues found. Ship it!"), "");
    return out.join("\n");
  }

  const parts: string[] = [];
  if (criticals.length > 0) parts.push(chalk.red(`${criticals.length} critical`));
  if (warnings.length > 0) parts.push(chalk.yellow(`${warnings.length} warnings`));
  if (infos.length > 0) parts.push(chalk.blue(`${infos.length} info`));
  out.push("  " + parts.join(chalk.dim(" · ")), "");

  const showIssues = options.verbose
    ? [...criticals, ...warnings, ...infos]
    : [...criticals, ...warnings].slice(0, MAX_ISSUES_DEFAULT);
  for (const issue of showIssues) out.push(...issueLines(issue));

  if (!options.verbose) {
    const remaining = criticals.length + warnings.length - showIssues.length;
    if (remaining > 0) out.push(chalk.dim(`  ... and ${remaining} more issues (use --verbose)`));
    if (infos.length > 0) out.push(chalk.dim(`  ${infos.length} info issues hidden (use --verbose)`));
  }
  out.push("");
  return out.join("\n");
}
