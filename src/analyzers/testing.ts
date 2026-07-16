import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

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

  // 6. Coverage threshold
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

  if (hasCoverageConfig) {
    checksPassed++;
  } else {
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
    summary: `${testFiles.length} test files, framework: ${framework}`,
  };
}
