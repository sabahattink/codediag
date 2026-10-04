import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeTesting } from "../src/analyzers/testing.js";
import { createScanContext } from "../src/core/scan-context.js";

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-testing-"));
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "tests"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ devDependencies: { vitest: "1.0.0" } }),
  );
  writeFileSync(
    join(directory, "src", "service.ts"),
    "export const value = 1;\n",
  );
  writeFileSync(join(directory, "tests", "service.test.ts"), "// test\n");
  writeFileSync(join(directory, "vitest.config.ts"), "export default {};\n");
  return directory;
}

function writeCoverage(
  directory: string,
  percentages: {
    lines: number;
    statements: number;
    functions: number;
    branches: number;
  },
): void {
  const coverageDirectory = join(directory, "coverage");
  mkdirSync(coverageDirectory);
  const metric = (pct: number) => ({
    total: 100,
    covered: pct,
    skipped: 0,
    pct,
  });
  writeFileSync(
    join(coverageDirectory, "coverage-summary.json"),
    JSON.stringify({
      total: {
        lines: metric(percentages.lines),
        statements: metric(percentages.statements),
        functions: metric(percentages.functions),
        branches: metric(percentages.branches),
      },
    }),
  );
}

test("testing analyzer scores a real coverage summary", async () => {
  const directory = createProject();
  try {
    writeCoverage(directory, {
      lines: 90,
      statements: 88,
      functions: 80,
      branches: 76,
    });

    const result = await analyzeTesting(createScanContext(directory));

    assert.match(result.summary, /coverage: 84%/);
    assert.equal(
      result.issues.some((issue) => issue.rule === "coverage-below-threshold"),
      false,
    );
    assert.ok(result.score >= 95);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("testing analyzer reports low coverage metrics", async () => {
  const directory = createProject();
  try {
    writeCoverage(directory, {
      lines: 75,
      statements: 78,
      functions: 45,
      branches: 60,
    });

    const result = await analyzeTesting(createScanContext(directory));
    const issue = result.issues.find(
      (candidate) => candidate.rule === "coverage-below-threshold",
    );

    assert.equal(issue?.severity, "critical");
    assert.equal(issue?.file, "coverage/coverage-summary.json");
    assert.match(issue?.message ?? "", /lines 75% < 80%/);
    assert.match(issue?.message ?? "", /functions 45% < 70%/);
    assert.match(result.summary, /coverage: 65%/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("testing analyzer reports malformed coverage without crashing", async () => {
  const directory = createProject();
  try {
    mkdirSync(join(directory, "coverage"));
    writeFileSync(
      join(directory, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: "unknown" } } }),
    );

    const result = await analyzeTesting(createScanContext(directory));

    assert.equal(
      result.issues.some((issue) => issue.rule === "invalid-coverage-report"),
      true,
    );
    assert.match(result.summary, /coverage: not reported/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function coverageConfigFinding(
  files: Record<string, string>,
  packageJson: Record<string, unknown> = {
    devDependencies: { vitest: "1.0.0" },
  },
): Promise<boolean> {
  const directory = createProject();
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content);
    }
    const result = await analyzeTesting(createScanContext(directory));
    return result.issues.some((issue) => issue.rule === "no-coverage-config");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("coverage thresholds are read from real configuration keys", async () => {
  // Mentioning coverage, or collecting it without thresholds, is not a gate.
  assert.equal(
    await coverageConfigFinding({
      "vitest.config.ts":
        '// coverage runs in CI\nexport default { test: { coverage: { provider: "v8" } } };\n',
    }),
    true,
  );
  assert.equal(
    await coverageConfigFinding({
      "vitest.config.ts":
        "export default { test: { coverage: { thresholds: { lines: 80 } } } };\n",
    }),
    false,
  );
  assert.equal(
    await coverageConfigFinding({
      "vite.config.mts":
        "export default defineConfig({ test: { coverage: { lines: 80 } } });\n",
    }),
    false,
  );
  assert.equal(
    await coverageConfigFinding(
      {
        "jest.config.js":
          "module.exports = { coverageThreshold: { global: { lines: 80 } } };\n",
      },
      { devDependencies: { jest: "29.0.0" } },
    ),
    false,
  );
  assert.equal(
    await coverageConfigFinding(
      {},
      {
        scripts: {
          test: "node --test --experimental-test-coverage --test-coverage-lines=80",
        },
      },
    ),
    false,
  );
  assert.equal(
    await coverageConfigFinding({
      ".c8rc.json": '{ "check-coverage": true, "lines": 90 }',
    }),
    false,
  );
});
