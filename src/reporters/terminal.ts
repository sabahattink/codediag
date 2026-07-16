import chalk from "chalk";
import type { ScanResult } from "../types.js";

function scoreBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color =
    score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  return color("\u2588".repeat(filled)) + chalk.dim("\u2591".repeat(empty));
}

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return chalk.green.bold(grade);
  if (grade.startsWith("B")) return chalk.cyan.bold(grade);
  if (grade.startsWith("C")) return chalk.yellow.bold(grade);
  if (grade.startsWith("D")) return chalk.hex("#FFA500").bold(grade);
  return chalk.red.bold(grade);
}

function severityIcon(severity: string): string {
  switch (severity) {
    case "critical":
      return chalk.red("\u2716");
    case "warning":
      return chalk.yellow("\u26A0");
    case "info":
      return chalk.blue("\u2139");
    default:
      return "\u00B7";
  }
}

export function renderTerminal(
  result: ScanResult,
  options: { quiet?: boolean; verbose?: boolean } = {},
): void {
  console.log();

  if (options.quiet) {
    const color =
      result.totalScore >= 80
        ? chalk.green
        : result.totalScore >= 60
          ? chalk.yellow
          : chalk.red;
    console.log(
      `  ${chalk.bold("codediag")} ${color(`${result.totalScore}/100`)} ${gradeColor(result.grade)}`,
    );
    console.log();
    return;
  }

  // Header
  console.log(
    chalk.bold("  codediag") + chalk.dim(" \u2014 Diagnostic Report"),
  );
  console.log();

  // Project info
  const stackLabel = [
    result.stack.framework,
    result.stack.language,
    result.stack.orm,
  ]
    .filter(Boolean)
    .join(chalk.dim(" + "));
  console.log(chalk.dim("  Project:  ") + chalk.white(result.project));
  console.log(chalk.dim("  Stack:    ") + stackLabel);
  console.log(
    chalk.dim("  Score:    ") +
      gradeColor(result.grade) +
      chalk.dim(` (${result.totalScore}/100)`),
  );
  console.log();

  // Scores
  for (const a of result.analyzers) {
    const bar = scoreBar(a.score);
    const scoreStr = String(a.score).padStart(3);
    console.log(
      `  ${chalk.dim(a.name.padEnd(16))} ${bar} ${chalk.bold(scoreStr)}`,
    );
  }
  console.log();

  // Issues
  const criticals = result.analyzers.flatMap((a) =>
    a.issues.filter((i) => i.severity === "critical"),
  );
  const warnings = result.analyzers.flatMap((a) =>
    a.issues.filter((i) => i.severity === "warning"),
  );
  const infos = result.analyzers.flatMap((a) =>
    a.issues.filter((i) => i.severity === "info"),
  );
  const total = criticals.length + warnings.length + infos.length;

  if (total > 0) {
    const parts: string[] = [];
    if (criticals.length > 0)
      parts.push(chalk.red(`${criticals.length} critical`));
    if (warnings.length > 0)
      parts.push(chalk.yellow(`${warnings.length} warnings`));
    if (infos.length > 0) parts.push(chalk.blue(`${infos.length} info`));
    console.log(`  ${parts.join(chalk.dim(" \u00B7 "))}`);
    console.log();

    const showIssues = options.verbose
      ? [...criticals, ...warnings, ...infos]
      : [...criticals, ...warnings].slice(0, 10);

    for (const issue of showIssues) {
      console.log(`  ${severityIcon(issue.severity)} ${issue.message}`);
      if (issue.file) console.log(chalk.dim(`    ${issue.file}`));
      if (issue.fix) console.log(chalk.dim(`    \u2192 ${issue.fix}`));
    }

    if (!options.verbose) {
      const remaining = criticals.length + warnings.length - showIssues.length;
      if (remaining > 0)
        console.log(chalk.dim(`  ... and ${remaining} more issues`));
      if (infos.length > 0 && !options.verbose)
        console.log(
          chalk.dim(`  ${infos.length} info issues hidden (use --verbose)`),
        );
    }
    console.log();
  } else {
    console.log(chalk.green("  \u2714 No issues found. Ship it!"));
    console.log();
  }
}
