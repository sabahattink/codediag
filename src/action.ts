import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isBelowThreshold, loadConfig, parseThreshold } from "./config.js";
import { loadBaseline } from "./core/baseline.js";
import {
  changedFiles,
  GitHubRequestError,
  pullRequestContext,
  upsertComment,
} from "./core/github-pr.js";
import { activeIssues, inactiveCounts } from "./core/issues.js";
import { previousScore, renderPrComment } from "./reporters/pr-comment.js";
import { renderSarif } from "./reporters/sarif.js";
import { scan } from "./scanner.js";
import type { DiagnosticIssue, ScanResult } from "./types.js";

const MAX_ANNOTATIONS = 50;

function getInput(name: string, fallback: string): string {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  return value || fallback;
}

function workflowEscape(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function writeOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`, "utf8");
  }
}

function issueAnnotation(issue: DiagnosticIssue): string {
  const level = issue.severity === "critical" ? "error" : "warning";
  const properties: string[] = [];

  if (issue.file) properties.push(`file=${workflowEscape(issue.file)}`);
  if (issue.line) properties.push(`line=${issue.line}`);
  properties.push(`title=${workflowEscape(`CodeDiag ${issue.rule}`)}`);

  return `::${level} ${properties.join(",")}::${workflowEscape(issue.message)}`;
}

function emitAnnotations(result: ScanResult): void {
  const issues = result.analyzers
    .flatMap(activeIssues)
    .filter((issue) => issue.severity !== "info");

  for (const issue of issues.slice(0, MAX_ANNOTATIONS)) {
    console.log(issueAnnotation(issue));
  }

  if (issues.length > MAX_ANNOTATIONS) {
    console.log(
      `::notice::CodeDiag omitted ${issues.length - MAX_ANNOTATIONS} additional annotations; see the JSON report.`,
    );
  }
}

function renderSummary(result: ScanResult, threshold: number): string {
  const lines = [
    "## CodeDiag project health",
    "",
    `**${markdownEscape(result.project)}:** ${result.totalScore}/100 (${result.grade})`,
    "",
    "| Analyzer | Score | Findings |",
    "| --- | ---: | ---: |",
  ];

  for (const analyzer of result.analyzers) {
    lines.push(
      `| ${markdownEscape(analyzer.name)} | ${analyzer.score}/100 | ${activeIssues(analyzer).length} |`,
    );
  }

  lines.push("", `Required threshold: **${threshold}/100**`);
  const inactive = inactiveCounts(result.analyzers);
  if (inactive.suppressed > 0 || inactive.baseline > 0) {
    lines.push(
      "",
      `Not counted: ${inactive.suppressed} suppressed in source, ${inactive.baseline} in the baseline.`,
    );
  }

  const actionable = result.analyzers.flatMap((analyzer) =>
    activeIssues(analyzer)
      .filter((issue) => issue.severity !== "info")
      .map((issue) => ({ analyzer: analyzer.name, issue })),
  );

  if (actionable.length > 0) {
    lines.push("", "<details>", "<summary>Actionable findings</summary>", "");
    for (const { analyzer, issue } of actionable.slice(0, MAX_ANNOTATIONS)) {
      const location = issue.file
        ? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`
        : "";
      lines.push(
        `- **${markdownEscape(analyzer)} / ${markdownEscape(issue.rule)}:** ${markdownEscape(issue.message)}${markdownEscape(location)}`,
      );
    }
    lines.push("", "</details>");
  }

  return `${lines.join("\n")}\n`;
}

function parseBooleanInput(name: string, value: string): boolean {
  if (/^(?:true|yes|1)$/i.test(value)) return true;
  if (/^(?:false|no|0|)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

/**
 * Creates or updates CodeDiag's pull request comment. A failure only warns,
 * because the scan result and threshold must not depend on comment access.
 */
async function commentOnPullRequest(
  result: ScanResult,
  threshold: number,
  workspace: string,
  projectPath: string,
): Promise<void> {
  try {
    const token = getInput("github-token", process.env.GITHUB_TOKEN ?? "");
    const context = pullRequestContext(process.env, token);
    if (!context) {
      console.log(
        "CodeDiag comment skipped: this run is not for a pull request.",
      );
      return;
    }
    if (!token) {
      console.log(
        "::warning title=CodeDiag pull request comment::No github-token is available, so no comment was posted.",
      );
      return;
    }
    const files = await changedFiles(context);
    const projectDirectory = relative(workspace, projectPath)
      .split(sep)
      .join("/");
    const outcome = await upsertComment(context, (previousBody) =>
      renderPrComment({
        result,
        threshold,
        changedFiles: files,
        projectDirectory,
        previousScore: previousBody ? previousScore(previousBody) : undefined,
      }),
    );
    console.log(`CodeDiag pull request comment ${outcome}.`);
  } catch (error) {
    const hint =
      error instanceof GitHubRequestError &&
      (error.status === 403 || error.status === 404)
        ? " Grant `pull-requests: write` in the workflow's permissions; pull requests from forks get a read-only token."
        : "";
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning title=CodeDiag pull request comment::${workflowEscape(`${message}.${hint}`)}`,
    );
  }
}

function resolveWorkspacePath(workspace: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(workspace, value);
}

function validatePathInput(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain line breaks.`);
  }

  return value;
}

export async function runAction(): Promise<void> {
  try {
    const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
    const projectPath = resolveWorkspacePath(
      workspace,
      validatePathInput("path", getInput("path", ".")),
    );
    const reportPath = resolveWorkspacePath(
      workspace,
      validatePathInput("report", getInput("report", "codediag-report.json")),
    );
    const sarifPath = resolveWorkspacePath(
      workspace,
      validatePathInput("sarif", getInput("sarif", "codediag-report.sarif")),
    );

    if (reportPath === sarifPath) {
      throw new Error("report and sarif must resolve to different files.");
    }

    const threshold = parseThreshold(getInput("threshold", "70"));
    const baselineInput = validatePathInput(
      "baseline",
      getInput("baseline", ""),
    );
    const baseline = baselineInput
      ? loadBaseline(resolveWorkspacePath(workspace, baselineInput))
      : undefined;

    const result = await scan(projectPath, loadConfig(projectPath), {
      baseline,
    });

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    mkdirSync(dirname(sarifPath), { recursive: true });
    writeFileSync(sarifPath, renderSarif(result), "utf8");

    writeOutput("score", String(result.totalScore));
    writeOutput("grade", result.grade);
    writeOutput("report", reportPath);
    writeOutput("sarif", sarifPath);
    emitAnnotations(result);

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary(result, threshold),
        "utf8",
      );
    }

    console.log(
      `CodeDiag score: ${result.totalScore}/100 (${result.grade}); JSON: ${reportPath}; SARIF: ${sarifPath}`,
    );

    if (parseBooleanInput("comment", getInput("comment", "false"))) {
      await commentOnPullRequest(result, threshold, workspace, projectPath);
    }

    if (isBelowThreshold(result.totalScore, threshold)) {
      console.log(
        `::error title=CodeDiag threshold not met::Score ${result.totalScore} is below the required threshold ${threshold}.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `::error title=CodeDiag action failed::${workflowEscape(message)}`,
    );
    process.exitCode = 2;
  }
}

void runAction();
