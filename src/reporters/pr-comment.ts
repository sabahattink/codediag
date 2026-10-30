import { posix } from "node:path";
import {
  findingsAtOrAbove,
  isBelowThreshold,
  packagesBelowThreshold,
} from "../config.js";
import { formatDelta } from "../core/compare.js";
import { activeIssues, inactiveCounts } from "../core/issues.js";
import { ruleDocsUrl } from "../rules/registry.js";
import type {
  CodediagConfig,
  ComparisonSummary,
  DiagnosticIssue,
  ScanResult,
} from "../types.js";

/** Identifies CodeDiag's comment so later runs update it instead of adding one. */
export const PR_COMMENT_MARKER = "<!-- codediag:pr-comment -->";
const SCORE_MARKER = /<!-- codediag:score=(\d+(?:\.\d+)?) -->/;
const MAX_LISTED_FINDINGS = 25;
const SEVERITY_ICONS = { critical: "🔴", warning: "🟡", info: "🔵" } as const;

export interface PrCommentInput {
  result: ScanResult;
  threshold: number;
  /** Fails the comment's status on active findings at or above it. */
  failOn?: CodediagConfig["failOn"];
  /** The score in the comment this one replaces, if any. */
  previousScore?: number;
  /** Repository-relative paths the pull request adds or modifies. */
  changedFiles: ReadonlySet<string>;
  /** The scanned project's directory relative to the repository root. */
  projectDirectory: string;
}

/** The score recorded in an earlier CodeDiag comment. */
export function previousScore(body: string): number | undefined {
  const match = SCORE_MARKER.exec(body);
  return match ? Number(match[1]) : undefined;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

/** The change against the base branch's report, when the scan compared one. */
function baseChange(comparison: ComparisonSummary): string {
  const delta = comparison.scoreDelta;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "=";
  return `${arrow} ${formatDelta(delta)} vs. the base branch (${comparison.previousScore}) · ${comparison.newFindings} new · ${comparison.fixedFindings} fixed`;
}

function scoreChange(score: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const delta = Math.round((score - previous) * 10) / 10;
  if (delta === 0) return "no change since the last run";
  return delta > 0
    ? `▲ +${delta} since the last run`
    : `▼ −${Math.abs(delta)} since the last run`;
}

interface LocatedFinding {
  issue: DiagnosticIssue;
  path: string;
}

function findingRow({ issue, path }: LocatedFinding): string {
  const location = issue.line ? `${path}:${issue.line}` : path;
  const badge = issue.isNew ? "**new** · " : "";
  return `| ${SEVERITY_ICONS[issue.severity]} | [\`${issue.rule}\`](${ruleDocsUrl(issue.rule)}) | \`${escapeCell(location)}\` | ${badge}${escapeCell(issue.message)} |`;
}

/**
 * One pull request comment: the score and its change since the last run, the
 * analyzer table, and the findings in files the pull request changes. Other
 * findings are only counted, so the comment stays about the change.
 */
export function renderPrComment(input: PrCommentInput): string {
  const { result, threshold, changedFiles, projectDirectory } = input;
  const failingPackages = packagesBelowThreshold(result.workspace);
  const failOn = input.failOn ?? null;
  const blocking = findingsAtOrAbove(result.analyzers, failOn).length;
  const passed =
    !isBelowThreshold(result.totalScore, threshold) &&
    failingPackages.length === 0 &&
    blocking === 0;
  const status = [
    result.comparison
      ? baseChange(result.comparison)
      : scoreChange(result.totalScore, input.previousScore),
    `threshold ${threshold}`,
    failOn
      ? `fails on ${failOn}${blocking > 0 ? ` (${blocking} found)` : ""}`
      : "",
    failingPackages.length > 0
      ? `below their package threshold: ${failingPackages
          .map(
            (entry) =>
              `\`${escapeCell(entry.path)}\` ${entry.totalScore}/${entry.threshold}`,
          )
          .join(", ")}`
      : "",
  ].filter(Boolean);

  const lines = [
    PR_COMMENT_MARKER,
    `<!-- codediag:score=${result.totalScore} -->`,
    `## ${passed ? "✅" : "❌"} CodeDiag: ${result.totalScore}/100 (${result.grade})`,
    "",
    status.join(" · "),
    "",
    "| Analyzer | Score | Findings |",
    "| --- | ---: | ---: |",
    ...result.analyzers.map(
      (analyzer) =>
        `| ${escapeCell(analyzer.name)} | ${analyzer.score}/100 | ${activeIssues(analyzer).length} |`,
    ),
    "",
  ];

  const actionable = result.analyzers
    .flatMap(activeIssues)
    .filter((issue) => issue.severity !== "info");
  const inChangedFiles: LocatedFinding[] = [];
  let elsewhere = 0;
  for (const issue of actionable) {
    const path = issue.file
      ? posix.join(projectDirectory, issue.file)
      : undefined;
    if (path && changedFiles.has(path)) inChangedFiles.push({ issue, path });
    else elsewhere += 1;
  }
  inChangedFiles.sort(
    (left, right) =>
      Number(right.issue.severity === "critical") -
        Number(left.issue.severity === "critical") ||
      left.path.localeCompare(right.path) ||
      (left.issue.line ?? 0) - (right.issue.line ?? 0),
  );

  if (inChangedFiles.length === 0) {
    lines.push("No findings in the files this pull request changes.");
  } else {
    lines.push(
      `### Findings in changed files (${inChangedFiles.length})`,
      "",
      "| | Rule | Location | Finding |",
      "| --- | --- | --- | --- |",
      ...inChangedFiles.slice(0, MAX_LISTED_FINDINGS).map(findingRow),
    );
    if (inChangedFiles.length > MAX_LISTED_FINDINGS) {
      lines.push(
        "",
        `…and ${inChangedFiles.length - MAX_LISTED_FINDINGS} more in the job summary and SARIF report.`,
      );
    }
  }

  const notCounted = inactiveCounts(result.analyzers);
  const footnotes = [
    elsewhere > 0
      ? `${elsewhere} finding${elsewhere === 1 ? "" : "s"} elsewhere in the project`
      : "",
    notCounted.suppressed > 0 ? `${notCounted.suppressed} suppressed` : "",
    notCounted.baseline > 0 ? `${notCounted.baseline} in the baseline` : "",
  ].filter(Boolean);
  if (footnotes.length > 0)
    lines.push("", `Not listed: ${footnotes.join(", ")}.`);

  lines.push(
    "",
    "<sub>Scanned by [CodeDiag](https://github.com/sabahattink/codediag) · updated on every push</sub>",
  );
  return `${lines.join("\n")}\n`;
}
