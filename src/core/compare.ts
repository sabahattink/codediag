import { readFileSync } from "node:fs";
import type {
  AnalyzerDelta,
  AnalyzerResult,
  ComparisonSummary,
  DiagnosticIssue,
  FixedFinding,
  ScanResult,
} from "../types.js";
import { activeIssues, isActive } from "./issues.js";

/** The parts of an earlier JSON report that a comparison reads. */
export interface PreviousReport {
  timestamp: string;
  totalScore: number;
  grade: string;
  analyzers: Array<{
    name: string;
    score: number;
    issues: DiagnosticIssue[];
  }>;
}

const SEVERITIES = new Set(["critical", "warning", "info"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIssue(value: unknown): DiagnosticIssue | null {
  if (
    !isRecord(value) ||
    typeof value.rule !== "string" ||
    typeof value.message !== "string" ||
    typeof value.severity !== "string" ||
    !SEVERITIES.has(value.severity)
  ) {
    return null;
  }
  return {
    rule: value.rule,
    message: value.message,
    severity: value.severity as DiagnosticIssue["severity"],
    ...(typeof value.file === "string" ? { file: value.file } : {}),
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    ...(typeof value.fingerprint === "string"
      ? { fingerprint: value.fingerprint }
      : {}),
    ...(isRecord(value.suppression)
      ? {
          suppression: {
            kind: "inSource" as const,
            justification: String(value.suppression.justification ?? ""),
          },
        }
      : {}),
    ...(value.baseline === true ? { baseline: true } : {}),
  };
}

/**
 * Reads an earlier CodeDiag JSON report (`--format json`, `--ci`, or
 * `--update-baseline`) for comparison. Reports from CodeDiag 0.3 or newer
 * carry the fingerprints that match findings across scans.
 */
export function loadReport(path: string): PreviousReport {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Cannot read report ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(document) ||
    !Array.isArray(document.analyzers) ||
    typeof document.totalScore !== "number" ||
    typeof document.grade !== "string" ||
    typeof document.timestamp !== "string"
  ) {
    throw new Error(`${path} is not a CodeDiag JSON report`);
  }

  const analyzers = document.analyzers.filter(isRecord).map((analyzer) => ({
    name: String(analyzer.name),
    score: typeof analyzer.score === "number" ? analyzer.score : 0,
    issues: (Array.isArray(analyzer.issues) ? analyzer.issues : [])
      .map(readIssue)
      .filter((issue): issue is DiagnosticIssue => issue !== null),
  }));
  const issues = analyzers.flatMap((analyzer) => analyzer.issues);
  if (issues.length > 0 && issues.every((issue) => !issue.fingerprint)) {
    throw new Error(
      `${path} has no finding fingerprints; write it with CodeDiag 0.3 or newer`,
    );
  }

  return {
    timestamp: document.timestamp,
    totalScore: document.totalScore,
    grade: document.grade,
    analyzers,
  };
}

function roundDelta(value: number): number {
  return Math.round(value * 10) / 10;
}

function analyzerDeltas(
  current: AnalyzerResult[],
  previous: PreviousReport["analyzers"],
): AnalyzerDelta[] {
  const names = [
    ...current.map((analyzer) => analyzer.name),
    ...previous
      .map((analyzer) => analyzer.name)
      .filter((name) => !current.some((analyzer) => analyzer.name === name)),
  ];
  return names.map((name) => {
    const now = current.find((analyzer) => analyzer.name === name);
    const before = previous.find((analyzer) => analyzer.name === name);
    const currentScore = now?.score ?? null;
    const previousScore = before?.score ?? null;
    return {
      name,
      previous: previousScore,
      current: currentScore,
      delta:
        currentScore !== null && previousScore !== null
          ? roundDelta(currentScore - previousScore)
          : null,
    };
  });
}

/**
 * Compares a scan with an earlier report: score changes per analyzer, active
 * findings that are new (marked `isNew`), and earlier findings that no longer
 * occur. With `scope`, only earlier findings in those files can count as
 * fixed, so a scan limited to changed files does not report the rest of the
 * project as fixed.
 */
export function compareWithPrevious(
  result: ScanResult,
  previous: PreviousReport,
  scope?: ReadonlySet<string>,
): ScanResult {
  const previousFingerprints = new Set(
    previous.analyzers.flatMap((analyzer) =>
      analyzer.issues
        .filter(isActive)
        .flatMap((issue) => (issue.fingerprint ? [issue.fingerprint] : [])),
    ),
  );
  const currentFingerprints = new Set(
    result.analyzers.flatMap((analyzer) =>
      activeIssues(analyzer).flatMap((issue) =>
        issue.fingerprint ? [issue.fingerprint] : [],
      ),
    ),
  );

  let newFindings = 0;
  const analyzers = result.analyzers.map((analyzer) => ({
    ...analyzer,
    issues: analyzer.issues.map((issue) => {
      if (
        !isActive(issue) ||
        !issue.fingerprint ||
        previousFingerprints.has(issue.fingerprint)
      ) {
        return issue;
      }
      newFindings += 1;
      return { ...issue, isNew: true };
    }),
  }));

  const fixed: FixedFinding[] = previous.analyzers.flatMap((analyzer) =>
    analyzer.issues
      .filter(
        (issue) =>
          isActive(issue) &&
          issue.fingerprint !== undefined &&
          !currentFingerprints.has(issue.fingerprint) &&
          (!scope || (issue.file !== undefined && scope.has(issue.file))),
      )
      .map((issue) => ({
        analyzer: analyzer.name,
        rule: issue.rule,
        severity: issue.severity,
        message: issue.message,
        ...(issue.file ? { file: issue.file } : {}),
        ...(issue.line ? { line: issue.line } : {}),
      })),
  );

  const comparison: ComparisonSummary = {
    previousTimestamp: previous.timestamp,
    previousScore: previous.totalScore,
    previousGrade: previous.grade,
    scoreDelta: roundDelta(result.totalScore - previous.totalScore),
    analyzers: analyzerDeltas(result.analyzers, previous.analyzers),
    newFindings,
    fixedFindings: fixed.length,
    fixed,
  };
  return { ...result, analyzers, comparison };
}

/** "+5", "−3", or "±0" with a true minus sign, for reports. */
export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return "±0";
}
