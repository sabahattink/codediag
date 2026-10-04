import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { isActive } from "../src/core/issues.js";
import { buildSarif } from "../src/reporters/sarif.js";
import { scan } from "../src/scanner.js";
import type {
  CodediagConfig,
  DiagnosticIssue,
  ScanResult,
} from "../src/types.js";

// Directive text is assembled at runtime so this file holds no real directives.
const NEXT_LINE = ["codediag", "ignore-next-line"].join("-");
const FILE = ["codediag", "ignore-file"].join("-");

async function withProject(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-suppress-"));
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

function securityOnly(directory: string): CodediagConfig {
  const config = loadConfig(directory);
  config.analyzers = {
    api: false,
    security: true,
    dependencies: false,
    testing: false,
    structure: true,
  };
  return config;
}

function findings(result: ScanResult): DiagnosticIssue[] {
  return result.analyzers.flatMap((analyzer) => analyzer.issues);
}

function summary(result: ScanResult) {
  return findings(result)
    .filter((issue) => issue.file?.startsWith("src/"))
    .map(({ rule, line, suppression, severity }) => ({
      rule,
      line,
      severity,
      ...(suppression ? { reason: suppression.justification } : {}),
    }));
}

const PROJECT = {
  "package.json": "{}",
  ".gitignore": ".env\n",
  "README.md": "x",
};

test("next-line and file directives suppress matching findings with a reason", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/run.ts": [
        `// ${NEXT_LINE} unsafe-dynamic-code -- trusted plugin code`,
        "eval(plugin);",
        "eval(other);",
      ].join("\n"),
      "src/tls.ts": [
        `/* ${FILE} tls-verification-disabled -- local dev proxy only */`,
        "const a = { rejectUnauthorized: false };",
        "const b = { rejectUnauthorized: false };",
      ].join("\n"),
    },
    async (directory) => {
      const result = await scan(directory, securityOnly(directory), {
        interactive: false,
      });

      assert.deepEqual(summary(result), [
        {
          rule: "unsafe-dynamic-code",
          line: 2,
          severity: "critical",
          reason: "trusted plugin code",
        },
        { rule: "unsafe-dynamic-code", line: 3, severity: "critical" },
        {
          rule: "tls-verification-disabled",
          line: 2,
          severity: "critical",
          reason: "local dev proxy only",
        },
        {
          rule: "tls-verification-disabled",
          line: 3,
          severity: "critical",
          reason: "local dev proxy only",
        },
      ]);
      const security = result.analyzers.find((a) => a.name === "Security");
      // Only the unsuppressed eval costs points.
      assert.deepEqual(security?.scoreBreakdown, [
        { rule: "unsafe-dynamic-code", count: 1, penalty: 25 },
      ]);
    },
  );
});

test("stacked directives skip each other to reach the code line", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/run.ts": [
        'import { execSync } from "node:child_process";',
        "export function run(command: string) {",
        `  // ${NEXT_LINE} unsafe-dynamic-code -- sandboxed`,
        `  // ${NEXT_LINE} dynamic-command-execution -- fixed binary`,
        "  eval(command); execSync(command);",
        "}",
      ].join("\n"),
    },
    async (directory) => {
      const result = await scan(directory, securityOnly(directory), {
        interactive: false,
      });
      assert.deepEqual(
        findings(result)
          .filter((issue) => issue.file === "src/run.ts")
          .map((issue) => [issue.rule, isActive(issue)]),
        [
          ["unsafe-dynamic-code", false],
          ["dynamic-command-execution", false],
        ],
      );
    },
  );
});

test("directives without a reason or match are reported and not applied", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/run.ts": [
        `// ${NEXT_LINE} unsafe-dynamic-code`,
        "eval(a);",
        `// ${NEXT_LINE} open-cors -- nothing here`,
        "const value = 1;",
        `// ${NEXT_LINE} not-a-rule -- typo`,
        "const other = 2;",
      ].join("\n"),
      "src/strings.ts": `const doc = "// ${NEXT_LINE} eval -- inside a string";\n`,
    },
    async (directory) => {
      const result = await scan(directory, securityOnly(directory), {
        interactive: false,
      });

      assert.deepEqual(
        findings(result)
          .filter((issue) => issue.file?.startsWith("src/"))
          .map(({ rule, line, severity }) => [rule, line, severity]),
        [
          ["unsafe-dynamic-code", 2, "critical"],
          ["suppression-missing-reason", 1, "info"],
          ["unused-suppression", 3, "info"],
          ["unused-suppression", 5, "info"],
        ],
      );
      assert.match(
        findings(result).find((issue) => issue.line === 5)?.message ?? "",
        /unknown rule not-a-rule/,
      );
    },
  );
});

test("rule configuration turns rules off or changes their severity", async () => {
  await withProject(
    {
      ...PROJECT,
      ".codediag.yml": [
        "rules:",
        "  unsafe-dynamic-code: warning",
        "  tls-verification-disabled: off",
      ].join("\n"),
      "src/run.ts": "eval(a);\nconst b = { rejectUnauthorized: false };\n",
    },
    async (directory) => {
      const result = await scan(directory, securityOnly(directory), {
        interactive: false,
      });
      assert.deepEqual(summary(result), [
        { rule: "unsafe-dynamic-code", line: 1, severity: "warning" },
      ]);
    },
  );
});

test("baseline findings are kept, marked, and excluded from the score", async () => {
  await withProject(
    { ...PROJECT, "src/run.ts": "eval(a);\n" },
    async (directory) => {
      const config = securityOnly(directory);
      const before = await scan(directory, config, { interactive: false });
      const baseline = new Set(
        findings(before).flatMap((issue) =>
          issue.fingerprint ? [issue.fingerprint] : [],
        ),
      );

      writeFileSync(
        join(directory, "src", "run.ts"),
        "// moved\neval(a);\neval(b);\n",
      );
      const after = await scan(directory, config, {
        interactive: false,
        baseline,
      });

      assert.deepEqual(
        findings(after)
          .filter((issue) => issue.file === "src/run.ts")
          .map(({ line, baseline: known }) => [line, known === true]),
        [
          [2, true],
          [3, false],
        ],
      );
      const security = after.analyzers.find((a) => a.name === "Security");
      assert.deepEqual(security?.scoreBreakdown, [
        { rule: "unsafe-dynamic-code", count: 1, penalty: 25 },
      ]);
    },
  );
});

test("SARIF marks inline suppressions and baseline state", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/run.ts": [
        `// ${NEXT_LINE} unsafe-dynamic-code -- reviewed`,
        "eval(a);",
        "eval(b);",
      ].join("\n"),
    },
    async (directory) => {
      const config = securityOnly(directory);
      const first = await scan(directory, config, { interactive: false });
      const known = findings(first).find(
        (issue) => issue.line === 3,
      )?.fingerprint;
      assert.ok(known);
      writeFileSync(
        join(directory, "src", "run.ts"),
        [
          `// ${NEXT_LINE} unsafe-dynamic-code -- reviewed`,
          "eval(a);",
          "eval(b);",
          "eval(c);",
        ].join("\n"),
      );
      const result = await scan(directory, config, {
        interactive: false,
        baseline: new Set([known]),
      });

      const results = buildSarif(result).runs[0].results.filter((entry) =>
        entry.ruleId.endsWith("/unsafe-dynamic-code"),
      );
      assert.deepEqual(
        results.map((entry) => ({
          line: entry.locations?.[0].physicalLocation.region?.startLine,
          baselineState: entry.baselineState,
          suppressions: entry.suppressions,
        })),
        [
          {
            line: 2,
            baselineState: "new",
            suppressions: [{ kind: "inSource", justification: "reviewed" }],
          },
          { line: 3, baselineState: "unchanged", suppressions: undefined },
          { line: 4, baselineState: "new", suppressions: undefined },
        ],
      );
    },
  );
});
