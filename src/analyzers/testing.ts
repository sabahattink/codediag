import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

const TEST_CONFIG_FILES = ["jest", "vitest"].flatMap((tool) =>
  ["ts", "js", "mjs", "mts"].map((extension) => `${tool}.config.${extension}`),
);
const COVERAGE_CONFIG_FILES = [
  ...TEST_CONFIG_FILES,
  ...["ts", "js", "mjs", "mts", "cjs", "cts"].map(
    (extension) => `vite.config.${extension}`,
  ),
  "jest.config.cjs",
  "jest.config.cts",
  "vitest.config.cjs",
  "vitest.config.cts",
];
const METRIC_KEYS = new Set(["lines", "statements", "functions", "branches"]);
const COVERAGE_RC_FILES = [".c8rc", ".c8rc.json", ".nycrc", ".nycrc.json"];
const COVERAGE_SCRIPT =
  /--test-coverage-(?:lines|branches|functions)=\d|--check-coverage\b|\bc8\b[^&|;]*--(?:lines|branches|functions|statements)\b/;

const COVERAGE_THRESHOLDS = {
  lines: 80,
  statements: 80,
  functions: 70,
  branches: 70,
} as const;

type CoverageMetricName = keyof typeof COVERAGE_THRESHOLDS;

interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

interface CoverageReport {
  file: string;
  metrics: Record<CoverageMetricName, CoverageMetric>;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCoverageMetric(value: unknown): CoverageMetric | null {
  if (!isRecord(value)) return null;

  const total = value.total;
  const covered = value.covered;
  const pct = value.pct;
  if (
    typeof total !== "number" ||
    typeof covered !== "number" ||
    typeof pct !== "number" ||
    !Number.isFinite(total) ||
    !Number.isFinite(covered) ||
    !Number.isFinite(pct) ||
    total < 0 ||
    covered < 0 ||
    covered > total ||
    pct < 0 ||
    pct > 100
  ) {
    return null;
  }

  return { total, covered, pct };
}

function readCoverageReport(projectPath: string): CoverageReport | null {
  const candidates = [
    join(projectPath, "coverage", "coverage-summary.json"),
    join(projectPath, "coverage-summary.json"),
  ];
  const reportPath = candidates.find((candidate) => existsSync(candidate));
  if (!reportPath) return null;

  const document: unknown = JSON.parse(readFileSync(reportPath, "utf-8"));
  if (!isRecord(document) || !isRecord(document.total)) {
    throw new Error("missing total coverage summary");
  }

  const metrics = {} as Record<CoverageMetricName, CoverageMetric>;
  for (const name of Object.keys(COVERAGE_THRESHOLDS) as CoverageMetricName[]) {
    const metric = parseCoverageMetric(document.total[name]);
    if (!metric) throw new Error(`invalid ${name} coverage metric`);
    metrics[name] = metric;
  }

  const score = Math.round(
    Object.values(metrics).reduce((sum, metric) => sum + metric.pct, 0) /
      Object.keys(metrics).length,
  );

  return {
    file: relative(projectPath, reportPath).replace(/\\/g, "/"),
    metrics,
    score,
  };
}

function propertyName(node: Node): string | undefined {
  return Node.isPropertyAssignment(node) ||
    Node.isShorthandPropertyAssignment(node)
    ? node.getName().replace(/["']/g, "")
    : undefined;
}

/**
 * Jest `coverageThreshold`, Vitest `coverage.thresholds`, or Vitest 0.x style
 * metric keys directly under `coverage` in a test or Vite config file.
 */
function configDeclaresThreshold(context: ScanContext, file: string): boolean {
  const sourceFile = context.getSourceFile(file);
  if (!sourceFile) return false;
  for (const property of sourceFile.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    const name = propertyName(property);
    if (name === "coverageThreshold") return true;
    const parent = property
      .getParentIfKind(SyntaxKind.ObjectLiteralExpression)
      ?.getParent();
    const parentName = parent ? propertyName(parent) : undefined;
    if (
      parentName === "coverage" &&
      (name === "thresholds" || METRIC_KEYS.has(name ?? ""))
    ) {
      return true;
    }
  }
  return false;
}

function coverageRcDeclaresThreshold(projectPath: string): boolean {
  return COVERAGE_RC_FILES.some((name) => {
    const path = join(projectPath, name);
    if (!existsSync(path)) return false;
    try {
      const options = JSON.parse(readFileSync(path, "utf-8"));
      return (
        options?.["check-coverage"] === true ||
        Object.keys(options ?? {}).some((key) => METRIC_KEYS.has(key))
      );
    } catch {
      return false;
    }
  });
}

function hasCoverageThreshold(context: ScanContext): boolean {
  const pkg = context.packageJson as
    | (Record<string, unknown> & { scripts?: Record<string, string> })
    | null;
  const jest = pkg?.jest as { coverageThreshold?: unknown } | undefined;
  const packageTool = (name: string) => {
    const options = pkg?.[name] as Record<string, unknown> | undefined;
    return Boolean(
      options &&
        (options["check-coverage"] === true ||
          Object.keys(options).some((key) => METRIC_KEYS.has(key))),
    );
  };
  return (
    Boolean(jest?.coverageThreshold) ||
    packageTool("c8") ||
    packageTool("nyc") ||
    Object.values(pkg?.scripts ?? {}).some((script) =>
      COVERAGE_SCRIPT.test(script),
    ) ||
    coverageRcDeclaresThreshold(context.projectPath) ||
    COVERAGE_CONFIG_FILES.some(
      (file) =>
        existsSync(join(context.projectPath, file)) &&
        configDeclaresThreshold(context, file),
    )
  );
}

export async function analyzeTesting(
  context: ScanContext,
): Promise<AnalyzerResult> {
  const { projectPath, packageJson: pkg } = context;
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  // 1. Test files exist
  checksRun++;
  const testFiles = context.matchFiles("**/*.{spec,test}.{ts,js,tsx,jsx}");

  if (testFiles.length > 0) {
    checksPassed++;
  } else {
    issues.push({
      ...fromRule("no-test-files"),
      message: "No test files found (*.spec.ts, *.test.ts)",
      fix: "Create test files alongside your source code",
    });
  }

  // 2. Test framework detected
  checksRun++;
  let framework = "none";
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.jest || deps["@jest/core"] || deps["ts-jest"]) framework = "jest";
    else if (deps.vitest) framework = "vitest";
    else if (deps.mocha) framework = "mocha";
    else if (deps.ava) framework = "ava";
    else if (
      pkg.scripts?.test?.includes("--test") ||
      pkg.scripts?.["test:cli"]?.includes("--test")
    )
      framework = "node:test";
  }

  if (framework !== "none") {
    checksPassed++;
  } else {
    issues.push({
      ...fromRule("no-test-framework"),
      message: "No test framework detected",
      fix: "Install jest or vitest",
    });
  }

  // 3. Test-to-source ratio
  checksRun++;
  const sourceFiles = context.matchFiles("**/*.{ts,js,tsx,jsx}", {
    exclude: ["**/*.spec.*", "**/*.test.*", "**/*.d.ts"],
  });

  const ratio =
    sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  if (ratio >= 0.3) {
    checksPassed++;
  } else if (ratio > 0) {
    checksPassed += 0.5;
    issues.push({
      ...fromRule("low-test-ratio"),
      message: `Test ratio: ${Math.round(ratio * 100)}% (${testFiles.length} tests / ${sourceFiles.length} source files)`,
      fix: "Aim for at least 1 test file per 3 source files",
    });
  } else {
    issues.push({
      ...fromRule("zero-test-ratio"),
      message: "No test files relative to source files",
    });
  }

  // 4. E2E test directory
  checksRun++;
  const hasE2e = ["test", "tests", "e2e", "__tests__"].some((dir) =>
    existsSync(join(projectPath, dir)),
  );
  if (hasE2e) {
    checksPassed++;
  } else {
    issues.push({
      ...fromRule("no-e2e-dir"),
      message: "No e2e/test directory found",
      fix: "Create a test/ or e2e/ directory for integration tests",
    });
  }

  // 5. Test config exists
  checksRun++;
  const hasConfig =
    existsSync(join(projectPath, "jest.config.js")) ||
    existsSync(join(projectPath, "jest.config.ts")) ||
    existsSync(join(projectPath, "jest.config.mjs")) ||
    existsSync(join(projectPath, "vitest.config.ts")) ||
    existsSync(join(projectPath, "vitest.config.js")) ||
    existsSync(join(projectPath, "vitest.config.mts"));

  if (hasConfig || framework === "node:test") {
    checksPassed++;
  } else {
    if (framework !== "none") {
      issues.push({
        ...fromRule("no-test-config"),
        message: `No ${framework} config file found`,
        fix: `Create ${framework}.config.ts`,
      });
    }
  }

  // 6. Coverage report or threshold configuration
  checksRun++;
  const hasCoverageConfig = hasCoverageThreshold(context);

  let coverageReport: CoverageReport | null = null;
  let invalidCoverageReport = false;
  try {
    coverageReport = readCoverageReport(projectPath);
  } catch (error) {
    invalidCoverageReport = true;
    issues.push({
      ...fromRule("invalid-coverage-report"),
      message: `Coverage summary could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: existsSync(join(projectPath, "coverage", "coverage-summary.json"))
        ? "coverage/coverage-summary.json"
        : "coverage-summary.json",
      fix: "Regenerate coverage-summary.json with Jest, Vitest, or Istanbul",
    });
  }

  if (coverageReport) {
    checksPassed += coverageReport.score / 100;
    const belowThreshold = (
      Object.keys(COVERAGE_THRESHOLDS) as CoverageMetricName[]
    ).filter(
      (name) => coverageReport.metrics[name].pct < COVERAGE_THRESHOLDS[name],
    );

    if (belowThreshold.length > 0) {
      const details = belowThreshold
        .map(
          (name) =>
            `${name} ${coverageReport.metrics[name].pct}% < ${COVERAGE_THRESHOLDS[name]}%`,
        )
        .join(", ");
      const isCritical = belowThreshold.some(
        (name) => coverageReport.metrics[name].pct < 50,
      );
      issues.push({
        ...fromRule("coverage-below-threshold"),
        severity: isCritical ? "critical" : "warning",
        message: `Coverage below recommended thresholds: ${details}`,
        file: coverageReport.file,
        fix: "Add tests for the uncovered code paths and regenerate coverage",
      });
    }
  } else if (hasCoverageConfig && !invalidCoverageReport) {
    checksPassed++;
  } else if (!invalidCoverageReport) {
    issues.push({
      ...fromRule("no-coverage-config"),
      message: "No coverage threshold configured",
      fix: "Add coverageThreshold to jest/vitest config",
    });
  }

  const score =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return {
    name: "Testing",
    score,
    issues,
    summary: `${testFiles.length} test files, framework: ${framework}, coverage: ${
      coverageReport ? `${coverageReport.score}%` : "not reported"
    }`,
  };
}
