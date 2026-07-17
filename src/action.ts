import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isBelowThreshold, loadConfig, parseThreshold } from "./config.js";
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
    .flatMap((analyzer) => analyzer.issues)
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
      `| ${markdownEscape(analyzer.name)} | ${analyzer.score}/100 | ${analyzer.issues.length} |`,
    );
  }

  lines.push("", `Required threshold: **${threshold}/100**`);

  const actionable = result.analyzers.flatMap((analyzer) =>
    analyzer.issues
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
    const threshold = parseThreshold(getInput("threshold", "70"));

    const result = await scan(projectPath, loadConfig(projectPath));

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    writeOutput("score", String(result.totalScore));
    writeOutput("grade", result.grade);
    writeOutput("report", reportPath);
    emitAnnotations(result);

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary(result, threshold),
        "utf8",
      );
    }

    console.log(
      `CodeDiag score: ${result.totalScore}/100 (${result.grade}); report: ${reportPath}`,
    );

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
