import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue } from "../types.js";
import { findFiles, TEST_AND_DECLARATION_GLOBS } from "../utils/files.js";
import { allDependencies, readPackageJsonOrNull } from "../utils/package-json.js";

const TEST_FILE_GLOBS = [
  "**/*.{spec,test}.{ts,js,tsx,jsx,mjs,cjs}",
  "**/*.e2e-spec.{ts,js}",
  "**/__tests__/**/*.{ts,js,tsx,jsx,mjs,cjs}",
];
const SOURCE_GLOB = "**/*.{ts,js,tsx,jsx}";
const TEST_CONFIG_FILES = [
  "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs",
  "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs",
];
const MIN_TEST_RATIO = 0.3;

function detectFramework(projectPath: string): string {
  const deps = allDependencies(readPackageJsonOrNull(projectPath));
  if (deps["jest"] || deps["@jest/core"] || deps["ts-jest"]) return "jest";
  if (deps["vitest"]) return "vitest";
  if (deps["mocha"]) return "mocha";
  if (deps["ava"]) return "ava";
  return "none";
}

function hasCoverageConfig(projectPath: string): boolean {
  const pkg = readPackageJsonOrNull(projectPath);
  const jest = pkg?.raw.jest;
  if (typeof jest === "object" && jest !== null && "coverageThreshold" in jest) return true;

  return TEST_CONFIG_FILES.some((name) => {
    const path = join(projectPath, name);
    if (!existsSync(path)) return false;
    try {
      const content = readFileSync(path, "utf-8");
      return content.includes("coverageThreshold") || content.includes("coverage");
    } catch {
      return false;
    }
  });
}

export async function analyzeTesting(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  // 1. Test files exist
  checksRun++;
  const testFiles = await findFiles(projectPath, TEST_FILE_GLOBS, ctx.ignore);
  if (testFiles.length > 0) {
    checksPassed++;
  } else {
    issues.push({ severity: "critical", rule: "no-test-files", message: "No test files found (*.spec.ts, *.test.ts)", fix: "Create test files alongside your source code" });
  }

  // 2. Test framework detected
  checksRun++;
  const framework = detectFramework(projectPath);
  if (framework !== "none") {
    checksPassed++;
  } else {
    issues.push({ severity: "warning", rule: "no-test-framework", message: "No test framework detected", fix: "Install jest or vitest" });
  }

  // 3. Test-to-source ratio
  checksRun++;
  const sourceFiles = await findFiles(projectPath, SOURCE_GLOB, ctx.ignore, TEST_AND_DECLARATION_GLOBS);
  const ratio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  if (ratio >= MIN_TEST_RATIO) {
    checksPassed++;
  } else if (ratio > 0) {
    checksPassed += 0.5;
    issues.push({ severity: "info", rule: "low-test-ratio", message: `Test ratio: ${Math.round(ratio * 100)}% (${testFiles.length} tests / ${sourceFiles.length} source files)`, fix: "Aim for at least 1 test file per 3 source files" });
  } else {
    issues.push({ severity: "warning", rule: "zero-test-ratio", message: "No test files relative to source files" });
  }

  // 4. E2E test directory
  checksRun++;
  const hasE2e = ["test", "tests", "e2e", "__tests__"].some((dir) => existsSync(join(projectPath, dir)));
  if (hasE2e) { checksPassed++; } else {
    issues.push({ severity: "info", rule: "no-e2e-dir", message: "No e2e/test directory found", fix: "Create a test/ or e2e/ directory for integration tests" });
  }

  // 5. Test config exists (jest may also be configured in package.json)
  checksRun++;
  const hasConfig =
    TEST_CONFIG_FILES.some((name) => existsSync(join(projectPath, name))) ||
    (framework === "jest" && readPackageJsonOrNull(projectPath)?.raw.jest !== undefined);
  if (hasConfig) { checksPassed++; } else if (framework !== "none") {
    issues.push({ severity: "info", rule: "no-test-config", message: `No ${framework} config file found`, fix: `Create ${framework}.config.ts` });
  }

  // 6. Coverage threshold
  checksRun++;
  if (hasCoverageConfig(projectPath)) { checksPassed++; } else {
    issues.push({ severity: "info", rule: "no-coverage-config", message: "No coverage threshold configured", fix: "Add coverageThreshold to jest/vitest config" });
  }

  const score = checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return { name: "Testing", score, issues, summary: `${testFiles.length} test files, framework: ${framework}` };
}
