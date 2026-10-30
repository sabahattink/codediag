import chalk from "chalk";
import { isBelowThreshold } from "../config.js";
import { formatDelta } from "../core/compare.js";
import { activeIssues, inactiveCounts } from "../core/issues.js";
import { formatPenalty } from "../core/scoring.js";
import { sparkline } from "../core/history.js";
import type {
  ComparisonSummary,
  HistoryPoint,
  ScanResult,
  WorkspaceSummary,
} from "../types.js";

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

function deltaText(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return "";
  const text = formatDelta(delta);
  if (delta > 0) return chalk.green(text);
  if (delta < 0) return chalk.red(text);
  return chalk.dim(text);
}

function comparisonLine(comparison: ComparisonSummary, score: number): string {
  const arrow =
    comparison.scoreDelta > 0
      ? chalk.green("▲")
      : comparison.scoreDelta < 0
        ? chalk.red("▼")
        : chalk.dim("=");
  return [
    `${arrow} ${deltaText(comparison.scoreDelta)} since ${comparison.previousTimestamp.slice(0, 10)}` +
      chalk.dim(` (${comparison.previousScore} → ${score})`),
    comparison.newFindings > 0
      ? chalk.magenta(`${comparison.newFindings} new`)
      : chalk.dim("0 new"),
    comparison.fixedFindings > 0
      ? chalk.green(`${comparison.fixedFindings} fixed`)
      : chalk.dim("0 fixed"),
  ].join(chalk.dim(" · "));
}

function renderFixed(comparison: ComparisonSummary): void {
  if (comparison.fixed.length === 0) return;
  console.log(chalk.green("  Fixed since the previous scan"));
  for (const finding of comparison.fixed) {
    const location = finding.file
      ? ` ${finding.line ? `${finding.file}:${finding.line}` : finding.file}`
      : "";
    console.log(
      `  ${chalk.green("✔")} ${chalk.dim(`${finding.message} [${finding.rule}]${location}`)}`,
    );
  }
  console.log();
}

function trendLine(history: HistoryPoint[]): string {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || history.length < 2) {
    return chalk.dim("first recorded scan");
  }
  const scores = history.map((point) => point.totalScore);
  const color =
    last.totalScore > first.totalScore
      ? chalk.green
      : last.totalScore < first.totalScore
        ? chalk.red
        : chalk.dim;
  return (
    color(sparkline(scores)) +
    chalk.dim(
      `  ${first.totalScore} → ${last.totalScore} over ${history.length} scans since ${first.timestamp.slice(0, 10)}`,
    )
  );
}

function renderPackages(workspace: WorkspaceSummary): void {
  const width = Math.max(
    16,
    ...workspace.packages.map((entry) => entry.path.length),
  );
  console.log(
    chalk.bold(`  Packages`) +
      chalk.dim(` (${workspace.tool} workspace, ${workspace.packages.length})`),
  );
  for (const entry of workspace.packages) {
    const findings = `${entry.findings} finding${entry.findings === 1 ? "" : "s"}`;
    const gate =
      entry.threshold !== undefined &&
      isBelowThreshold(entry.totalScore, entry.threshold)
        ? ` ${chalk.red.bold(`below ${entry.threshold}`)}`
        : "";
    console.log(
      `  ${chalk.dim(entry.path.padEnd(width))} ${scoreBar(entry.totalScore)} ${chalk.bold(String(entry.totalScore).padStart(3))} ${gradeColor(entry.grade.padEnd(2))} ${chalk.dim(findings)}${gate}`,
    );
  }
  console.log();
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
  // A workspace root has no stack of its own; name its packages' frameworks.
  const stackLabel = result.workspace
    ? `${result.workspace.tool} workspace` +
      chalk.dim(
        ` (${[...new Set(result.workspace.packages.map((entry) => entry.framework))].join(", ")})`,
      )
    : [result.stack.framework, result.stack.language, result.stack.orm]
        .filter(Boolean)
        .join(chalk.dim(" + "));
  console.log(chalk.dim("  Project:  ") + chalk.white(result.project));
  console.log(chalk.dim("  Stack:    ") + stackLabel);
  console.log(
    chalk.dim("  Score:    ") +
      gradeColor(result.grade) +
      chalk.dim(` (${result.totalScore}/100)`),
  );
  if (result.scope) {
    const { changedSince, files, excludedFindings } = result.scope;
    console.log(
      chalk.dim("  Scope:    ") +
        `${files} file${files === 1 ? "" : "s"} changed since ${changedSince}` +
        chalk.dim(
          ` (${excludedFindings} finding${excludedFindings === 1 ? "" : "s"} elsewhere not scored)`,
        ),
    );
  }
  if (result.comparison) {
    console.log(
      chalk.dim("  Change:   ") +
        comparisonLine(result.comparison, result.totalScore),
    );
  }
  if (result.history) {
    console.log(chalk.dim("  Trend:    ") + trendLine(result.history));
  }
  console.log();
  if (result.workspace) renderPackages(result.workspace);

  // Scores
  for (const a of result.analyzers) {
    const bar = scoreBar(a.score);
    const scoreStr = String(a.score).padStart(3);
    const delta = result.comparison?.analyzers.find(
      (entry) => entry.name === a.name,
    )?.delta;
    console.log(
      `  ${chalk.dim(a.name.padEnd(16))} ${bar} ${chalk.bold(scoreStr)}${delta ? ` ${deltaText(delta)}` : ""}`,
    );
    if (options.verbose) {
      for (const entry of a.scoreBreakdown ?? []) {
        console.log(
          chalk.dim(
            `    ${formatPenalty(entry.penalty).padStart(6)}  ${entry.rule} ×${entry.count}`,
          ),
        );
      }
    }
  }
  console.log();

  // Issues
  const criticals = result.analyzers.flatMap((a) =>
    activeIssues(a).filter((i) => i.severity === "critical"),
  );
  const warnings = result.analyzers.flatMap((a) =>
    activeIssues(a).filter((i) => i.severity === "warning"),
  );
  const infos = result.analyzers.flatMap((a) =>
    activeIssues(a).filter((i) => i.severity === "info"),
  );
  const total = criticals.length + warnings.length + infos.length;
  const inactive = inactiveCounts(result.analyzers);
  const notCounted = [
    inactive.suppressed > 0 ? `${inactive.suppressed} suppressed` : "",
    inactive.baseline > 0 ? `${inactive.baseline} in baseline` : "",
  ].filter(Boolean);

  if (total > 0) {
    const parts: string[] = [];
    if (criticals.length > 0)
      parts.push(chalk.red(`${criticals.length} critical`));
    if (warnings.length > 0)
      parts.push(chalk.yellow(`${warnings.length} warnings`));
    if (infos.length > 0) parts.push(chalk.blue(`${infos.length} info`));
    for (const label of notCounted) parts.push(chalk.dim(label));
    console.log(`  ${parts.join(chalk.dim(" \u00B7 "))}`);
    console.log();

    const showIssues = options.verbose
      ? [...criticals, ...warnings, ...infos]
      : [...criticals, ...warnings].slice(0, 10);

    for (const issue of showIssues) {
      const cause = issue.causedBy
        ? chalk.dim(` (caused by ${issue.causedBy})`)
        : "";
      const badge = issue.isNew ? `${chalk.magenta.bold("NEW")} ` : "";
      console.log(
        `  ${severityIcon(issue.severity)} ${badge}${issue.message}${cause} ${chalk.dim(`[${issue.rule}]`)}`,
      );
      if (issue.file) {
        const location = issue.line
          ? `${issue.file}:${issue.line}`
          : issue.file;
        console.log(chalk.dim(`    ${location}`));
      }
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
    if (options.verbose && result.comparison) renderFixed(result.comparison);
  } else {
    console.log(chalk.green("  \u2714 No issues found. Ship it!"));
    if (notCounted.length > 0) {
      console.log(chalk.dim(`  ${notCounted.join(" \u00B7 ")}`));
    }
    console.log();
  }
}
