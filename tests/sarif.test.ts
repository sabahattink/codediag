import assert from "node:assert/strict";
import test from "node:test";
import { renderSarif } from "../src/reporters/sarif.js";
import type { ScanResult } from "../src/types.js";

interface SarifView {
  $schema: string;
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        semanticVersion: string;
        rules: Array<{ id: string }>;
      };
    };
    invocations: Array<{
      executionSuccessful: boolean;
      endTimeUtc: string;
    }>;
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      locations?: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number };
        };
      }>;
      partialFingerprints: { "codediagFinding/v1": string };
      properties: { recommendation?: string };
    }>;
    properties: {
      project: string;
      framework: string;
      score: number;
      grade: string;
    };
  }>;
}

function fixture(): ScanResult {
  return {
    project: "api fixture",
    stack: {
      framework: "nestjs",
      language: "typescript",
      orm: null,
      hasDocker: true,
      hasEnvFile: false,
      hasPrisma: false,
      hasTests: true,
      packageManager: "npm",
    },
    analyzers: [
      {
        name: "Security Analyzer",
        score: 62,
        summary: "Two findings",
        issues: [
          {
            severity: "critical",
            rule: "No hardcoded secret",
            message: "Potential secret found.",
            file: "src\\auth key.ts",
            line: 12,
            fix: "Move the value to an environment variable.",
          },
          {
            severity: "warning",
            rule: "No hardcoded secret",
            message: "Another potential secret found.",
            file: "src/config.ts",
          },
          {
            severity: "info",
            rule: "Review headers",
            message: "Review response headers.",
          },
        ],
      },
    ],
    totalScore: 62,
    grade: "C",
    timestamp: "2026-07-17T08:00:00.000Z",
  };
}

test("SARIF reporter emits deterministic SARIF 2.1.0 findings", () => {
  const first = renderSarif(fixture());
  const second = renderSarif(fixture());
  const sarif = JSON.parse(first) as SarifView;

  assert.equal(first, second);
  assert.equal(sarif.version, "2.1.0");
  assert.equal(
    sarif.$schema,
    "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  );
  assert.equal(sarif.runs.length, 1);

  const [run] = sarif.runs;
  assert.equal(run.tool.driver.name, "CodeDiag");
  assert.match(run.tool.driver.semanticVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    run.tool.driver.rules.map((rule) => rule.id),
    [
      "codediag/security-analyzer/no-hardcoded-secret",
      "codediag/security-analyzer/review-headers",
    ],
  );
  assert.deepEqual(
    run.results.map((result) => result.level),
    ["error", "warning", "note"],
  );
  assert.equal(run.results[0].ruleIndex, run.results[1].ruleIndex);
  assert.equal(run.results[2].ruleIndex, 1);
  assert.equal(
    run.results[0].locations?.[0].physicalLocation.artifactLocation.uri,
    "src/auth%20key.ts",
  );
  assert.equal(
    run.results[0].locations?.[0].physicalLocation.region?.startLine,
    12,
  );
  assert.equal(
    run.results[0].properties.recommendation,
    "Move the value to an environment variable.",
  );
  assert.match(
    run.results[0].partialFingerprints["codediagFinding/v1"],
    /^[a-f0-9]{64}$/,
  );
  assert.equal(run.results[2].locations, undefined);
  assert.deepEqual(run.invocations, [
    {
      executionSuccessful: true,
      endTimeUtc: "2026-07-17T08:00:00.000Z",
    },
  ]);
  assert.deepEqual(run.properties, {
    project: "api fixture",
    framework: "nestjs",
    score: 62,
    grade: "C",
  });
});
