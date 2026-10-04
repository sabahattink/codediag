import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { computeFingerprint, FINGERPRINT_KEY } from "../core/fingerprint.js";
import { getRule, ruleDocsUrl } from "../rules/registry.js";
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

function cweTags(cwe: readonly string[]): string[] {
  return cwe.map(
    (id) => `external/cwe/cwe-${id.replace(/^CWE-/i, "").padStart(3, "0")}`,
  );
}

function ruleDescriptor(analyzer: AnalyzerResult, issue: DiagnosticIssue) {
  const definition = getRule(issue.rule);
  const severity = definition?.defaultSeverity ?? issue.severity;
  const tags = definition?.cwe?.length
    ? ["security", ...cweTags(definition.cwe)]
    : [];

  return {
    id: ruleId(analyzer, issue),
    name: issue.rule,
    shortDescription: { text: definition?.title ?? issue.rule },
    fullDescription: { text: definition?.description ?? issue.message },
    ...(definition
      ? {
          helpUri: ruleDocsUrl(issue.rule),
          help: {
            text: `${definition.description} See ${ruleDocsUrl(issue.rule)}`,
          },
        }
      : {}),
    defaultConfiguration: { level: sarifLevel(severity) },
    properties: {
      analyzer: analyzer.name,
      severity,
      ...(tags.length > 0 ? { tags } : {}),
      ...(definition?.owasp?.length ? { owasp: [...definition.owasp] } : {}),
    },
  };
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
  const rules: Array<ReturnType<typeof ruleDescriptor>> = [];

  for (const { analyzer, issue } of findings) {
    const id = ruleId(analyzer, issue);
    if (ruleIndexes.has(id)) continue;

    ruleIndexes.set(id, rules.length);
    rules.push(ruleDescriptor(analyzer, issue));
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
      ...(issue.suppression
        ? {
            suppressions: [
              {
                kind: issue.suppression.kind,
                justification: issue.suppression.justification,
              },
            ],
          }
        : {}),
      ...(result.baseline
        ? { baselineState: issue.baseline ? "unchanged" : "new" }
        : {}),
      partialFingerprints: {
        [FINGERPRINT_KEY]: issue.fingerprint ?? computeFingerprint(issue, null),
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
