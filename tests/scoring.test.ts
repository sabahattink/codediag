import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { applyScoring } from "../src/core/scoring.js";
import { scan } from "../src/scanner.js";
import type {
  AnalyzerResult,
  CodediagConfig,
  DiagnosticIssue,
} from "../src/types.js";

function analyzer(name: string, issues: DiagnosticIssue[]): AnalyzerResult {
  return { name, score: 100, issues, summary: "" };
}

function issue(
  rule: string,
  severity: DiagnosticIssue["severity"],
  file?: string,
): DiagnosticIssue {
  return { severity, rule, message: rule, ...(file ? { file } : {}) };
}

async function withProject(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-scoring-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function onlyAnalyzer(
  directory: string,
  key: keyof CodediagConfig["analyzers"],
  version: 1 | 2 = 2,
): CodediagConfig {
  const config = loadConfig(directory);
  config.scoring = { version };
  config.analyzers = {
    api: false,
    security: false,
    dependencies: false,
    testing: false,
    structure: false,
    [key]: true,
  };
  return config;
}

test("version 2 subtracts severity weights with diminishing repeats", () => {
  const [result] = applyScoring(
    [
      analyzer("Security", [
        issue("open-cors", "warning", "a.ts"),
        issue("no-helmet", "warning"),
        issue("no-rate-limiting", "warning"),
        issue("dynamic-sql-query", "warning", "a.ts"),
        issue("dynamic-sql-query", "critical", "b.ts"),
        issue("dynamic-sql-query", "warning", "c.ts"),
      ]),
    ],
    2,
  );

  // 8 + 8 + 8 + (25 + 8 * 0.5 + 8 * 0.25) = 55
  assert.equal(result.score, 45);
  assert.deepEqual(result.scoreBreakdown, [
    { rule: "dynamic-sql-query", count: 3, penalty: 31 },
    { rule: "no-helmet", count: 1, penalty: 8 },
    { rule: "no-rate-limiting", count: 1, penalty: 8 },
    { rule: "open-cors", count: 1, penalty: 8 },
  ]);
});

test("many findings of one rule outweigh a single configuration gap", () => {
  const injections = Array.from({ length: 50 }, (_, index) =>
    issue("dynamic-sql-query", "critical", `src/q${index}.ts`),
  );
  const [manyInjections, missingGitignore] = applyScoring(
    [
      analyzer("Security", injections),
      analyzer("Security", [issue("no-gitignore", "critical")]),
    ],
    2,
  );

  assert.ok(manyInjections.score < missingGitignore.score);
  assert.equal(missingGitignore.score, 75);
  assert.equal(manyInjections.score, 50);
});

test("scores floor at zero and analyzer-blocking findings score zero", () => {
  const [floored, blocked] = applyScoring(
    [
      analyzer(
        "Security",
        ["no-gitignore", "hardcoded-secret", "unsafe-dynamic-code"].flatMap(
          (rule) => [issue(rule, "critical", "a.ts"), issue(rule, "critical")],
        ),
      ),
      analyzer("Dependencies", [issue("no-package-json", "critical")]),
    ],
    2,
  );

  assert.equal(floored.score, 0);
  assert.equal(blocked.score, 0);
  assert.deepEqual(blocked.scoreBreakdown, [
    { rule: "no-package-json", count: 1, penalty: 100 },
  ]);
});

test("findings explained by a reported root cause are downgraded and free", () => {
  const [result] = applyScoring(
    [
      analyzer("Testing", [
        issue("no-test-files", "critical"),
        issue("no-test-framework", "warning"),
        issue("zero-test-ratio", "warning"),
        issue("no-e2e-dir", "info"),
        issue("no-coverage-config", "info"),
      ]),
    ],
    2,
  );

  // No tests leaves the Testing analyzer nothing to evaluate.
  assert.equal(result.score, 0);
  assert.deepEqual(result.scoreBreakdown, [
    { rule: "no-test-files", count: 1, penalty: 100 },
    { rule: "no-test-framework", count: 1, penalty: 8 },
  ]);
  assert.deepEqual(
    result.issues.map(({ rule, severity, causedBy }) => ({
      rule,
      severity,
      causedBy,
    })),
    [
      { rule: "no-test-files", severity: "critical", causedBy: undefined },
      { rule: "no-test-framework", severity: "warning", causedBy: undefined },
      { rule: "zero-test-ratio", severity: "info", causedBy: "no-test-files" },
      { rule: "no-e2e-dir", severity: "info", causedBy: "no-test-files" },
      {
        rule: "no-coverage-config",
        severity: "info",
        causedBy: "no-test-files",
      },
    ],
  );
});

test("version 1 keeps analyzer scores and findings unchanged", () => {
  const input = [
    analyzer("Testing", [
      issue("no-test-files", "critical"),
      issue("zero-test-ratio", "warning"),
    ]),
  ];
  input[0].score = 17;

  assert.deepEqual(applyScoring(input, 1), input);
});

test("version 2 no longer counts GET endpoints that cannot produce findings", async () => {
  await withProject(
    {
      "package.json": JSON.stringify({
        dependencies: { "@nestjs/core": "10.0.0" },
      }),
      "src/health.controller.ts": [
        "@ApiTags('health')",
        "@Controller('health')",
        "export class HealthController {",
        "  @Get() check(): string { return 'ok'; }",
        "  @Get('ready') ready(): string { return 'ok'; }",
        "}",
      ].join("\n"),
    },
    async (directory) => {
      const v1 = await scan(directory, onlyAnalyzer(directory, "api", 1), {
        interactive: false,
      });
      const v2 = await scan(directory, onlyAnalyzer(directory, "api"), {
        interactive: false,
      });

      assert.deepEqual(v1.analyzers[0].issues, []);
      assert.equal(v1.analyzers[0].score, 65);
      assert.equal(v2.analyzers[0].score, 100);
      assert.deepEqual(v2.analyzers[0].scoreBreakdown, []);
      assert.equal(v2.scoringVersion, 2);
    },
  );
});

test("scan defaults to version 2 and reports a score breakdown", async () => {
  await withProject(
    { "package.json": "{}", "src/index.ts": "export const a = 1;\n" },
    async (directory) => {
      const result = await scan(directory, onlyAnalyzer(directory, "testing"), {
        interactive: false,
      });
      const [testing] = result.analyzers;

      assert.equal(loadConfig(directory).scoring.version, 2);
      assert.equal(result.scoringVersion, 2);
      assert.equal(
        Math.max(
          0,
          100 -
            (testing.scoreBreakdown ?? []).reduce(
              (sum, entry) => sum + entry.penalty,
              0,
            ),
        ),
        testing.score,
      );
      assert.ok((testing.scoreBreakdown ?? []).length > 0);
    },
  );
});

test("version 2 replaces checks-passed summaries with finding counts", () => {
  const input = analyzer("Security", [
    issue("no-helmet", "warning"),
    issue("hardcoded-secret", "critical", "a.ts"),
  ]);
  input.summary = "5/7 checks passed";
  const testing = analyzer("Testing", []);
  testing.summary = "3 test files, framework: vitest";

  const [security, unchanged] = applyScoring([input, testing], 2);

  assert.equal(security.summary, "2 findings: 1 critical, 1 warning");
  assert.equal(unchanged.summary, "3 test files, framework: vitest");
});

test("accepted root causes no longer excuse their consequences", () => {
  const [result] = applyScoring(
    [
      analyzer("Dependencies", [
        {
          ...issue("lock-file-manager-mismatch", "critical"),
          baseline: true,
        },
        issue("audit-unavailable", "warning"),
      ]),
    ],
    2,
  );

  assert.equal(result.issues[1].causedBy, undefined);
  assert.deepEqual(result.scoreBreakdown, [
    { rule: "audit-unavailable", count: 1, penalty: 8 },
  ]);
});

test("a configured severity replaces the analyzer-failing penalty", () => {
  const [result] = applyScoring(
    [analyzer("Testing", [issue("no-test-files", "info")])],
    2,
    { "no-test-files": "info" },
  );

  assert.equal(result.score, 98);
});
