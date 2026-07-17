import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

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

export async function analyzeTesting(
  projectPath: string,
  ignore: string[] = ["node_modules/**", "dist/**"],
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  // 1. Test files exist
  checksRun++;
  const testFiles = await glob("**/*.{spec,test}.{ts,js,tsx,jsx}", {
    cwd: projectPath,
    ignore,
  });

  if (testFiles.length > 0) {
    checksPassed++;
  } else {
    issues.push({
      severity: "critical",
      rule: "no-test-files",
      message: "No test files found (*.spec.ts, *.test.ts)",
      fix: "Create test files alongside your source code",
    });
  }

  // 2. Test framework detected
  checksRun++;
  const pkgPath = join(projectPath, "package.json");
  let framework = "none";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.jest || deps["@jest/core"] || deps["ts-jest"])
        framework = "jest";
      else if (deps.vitest) framework = "vitest";
      else if (deps.mocha) framework = "mocha";
      else if (deps.ava) framework = "ava";
      else if (
        pkg.scripts?.test?.includes("--test") ||
        pkg.scripts?.["test:cli"]?.includes("--test")
      )
        framework = "node:test";
    } catch {
      /* skip */
    }
  }

  if (framework !== "none") {
    checksPassed++;
  } else {
    issues.push({
      severity: "warning",
      rule: "no-test-framework",
      message: "No test framework detected",
      fix: "Install jest or vitest",
    });
  }

  // 3. Test-to-source ratio
  checksRun++;
  const sourceFiles = await glob("**/*.{ts,js,tsx,jsx}", {
    cwd: projectPath,
    ignore: [...ignore, "**/*.spec.*", "**/*.test.*", "**/*.d.ts"],
  });

  const ratio =
    sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  if (ratio >= 0.3) {
    checksPassed++;
  } else if (ratio > 0) {
    checksPassed += 0.5;
    issues.push({
      severity: "info",
      rule: "low-test-ratio",
      message: `Test ratio: ${Math.round(ratio * 100)}% (${testFiles.length} tests / ${sourceFiles.length} source files)`,
      fix: "Aim for at least 1 test file per 3 source files",
    });
  } else {
    issues.push({
      severity: "warning",
      rule: "zero-test-ratio",
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
      severity: "info",
      rule: "no-e2e-dir",
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
        severity: "info",
        rule: "no-test-config",
        message: `No ${framework} config file found`,
        fix: `Create ${framework}.config.ts`,
      });
    }
  }

  // 6. Coverage report or threshold configuration
  checksRun++;
  let hasCoverageConfig = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.jest?.coverageThreshold) hasCoverageConfig = true;
    } catch {
      /* skip */
    }
  }

  const configFiles = await glob("{jest,vitest}.config.{ts,js,mjs,mts}", {
    cwd: projectPath,
    absolute: true,
  });
  for (const cf of configFiles) {
    try {
      if (
        readFileSync(cf, "utf-8").includes("coverageThreshold") ||
        readFileSync(cf, "utf-8").includes("coverage")
      ) {
        hasCoverageConfig = true;
        break;
      }
    } catch {
      /* skip */
    }
  }

  let coverageReport: CoverageReport | null = null;
  let invalidCoverageReport = false;
  try {
    coverageReport = readCoverageReport(projectPath);
  } catch (error) {
    invalidCoverageReport = true;
    issues.push({
      severity: "warning",
      rule: "invalid-coverage-report",
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
        severity: isCritical ? "critical" : "warning",
        rule: "coverage-below-threshold",
        message: `Coverage below recommended thresholds: ${details}`,
        file: coverageReport.file,
        fix: "Add tests for the uncovered code paths and regenerate coverage",
      });
    }
  } else if (hasCoverageConfig && !invalidCoverageReport) {
    checksPassed++;
  } else if (!invalidCoverageReport) {
    issues.push({
      severity: "info",
      rule: "no-coverage-config",
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
