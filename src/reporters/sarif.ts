import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnalyzerResult, DiagnosticIssue, ScanResult } from "../types.js";
import { getPackageVersion } from "../version.js";

const SARIF_SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "unknown";
}

function ruleId(analyzer: AnalyzerResult, issue: DiagnosticIssue): string {
  return `codediag/${slug(analyzer.name)}/${slug(issue.rule)}`;
}

function sarifLevel(
  severity: DiagnosticIssue["severity"],
): "error" | "warning" | "note" {
  switch (severity) {
    case "critical":
      return "error";
    case "warning":
      return "warning";
    default:
      return "note";
  }
}

function artifactUri(file: string): string {
  if (isAbsolute(file)) {
    return pathToFileURL(file).href;
  }

  return file
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function fingerprint(analyzer: AnalyzerResult, issue: DiagnosticIssue): string {
  return createHash("sha256")
    .update(
      [
        analyzer.name,
        issue.rule,
        issue.file ?? "",
        issue.line?.toString() ?? "",
        issue.message,
      ].join("\u0000"),
    )
    .digest("hex");
}

function resultLocation(issue: DiagnosticIssue) {
  if (!issue.file) return undefined;

  return [
    {
      physicalLocation: {
        artifactLocation: {
          uri: artifactUri(issue.file),
        },
        ...(issue.line
          ? {
              region: {
                startLine: issue.line,
              },
            }
          : {}),
      },
    },
  ];
}

export function buildSarif(result: ScanResult) {
  const findings = result.analyzers.flatMap((analyzer) =>
    analyzer.issues.map((issue) => ({ analyzer, issue })),
  );
  const ruleIndexes = new Map<string, number>();
  const rules: Array<{
    id: string;
    name: string;
    shortDescription: { text: string };
    fullDescription: { text: string };
    defaultConfiguration: { level: "error" | "warning" | "note" };
    properties: { analyzer: string; severity: DiagnosticIssue["severity"] };
  }> = [];

  for (const { analyzer, issue } of findings) {
    const id = ruleId(analyzer, issue);
    if (ruleIndexes.has(id)) continue;

    ruleIndexes.set(id, rules.length);
    rules.push({
      id,
      name: issue.rule,
      shortDescription: { text: issue.rule },
      fullDescription: { text: issue.message },
      defaultConfiguration: { level: sarifLevel(issue.severity) },
      properties: {
        analyzer: analyzer.name,
        severity: issue.severity,
      },
    });
  }

  const sarifResults = findings.map(({ analyzer, issue }) => {
    const id = ruleId(analyzer, issue);
    const index = ruleIndexes.get(id);
    const locations = resultLocation(issue);
    if (index === undefined) {
      throw new Error(`SARIF rule index was not generated for ${id}`);
    }

    return {
      ruleId: id,
      ruleIndex: index,
      level: sarifLevel(issue.severity),
      message: { text: issue.message },
      ...(locations ? { locations } : {}),
      partialFingerprints: {
        "codediagFinding/v1": fingerprint(analyzer, issue),
      },
      properties: {
        analyzer: analyzer.name,
        analyzerScore: analyzer.score,
        severity: issue.severity,
        ...(issue.fix ? { recommendation: issue.fix } : {}),
      },
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: "CodeDiag",
            semanticVersion: getPackageVersion(),
            informationUri: "https://github.com/sabahattink/codediag",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            endTimeUtc: result.timestamp,
          },
        ],
        results: sarifResults,
        properties: {
          project: result.project,
          framework: result.stack.framework,
          score: result.totalScore,
          grade: result.grade,
        },
      },
    ],
  };
}

export function renderSarif(result: ScanResult): string {
  return `${JSON.stringify(buildSarif(result), null, 2)}\n`;
}
