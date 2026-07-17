import { existsSync } from "node:fs";
import { basename } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { analyzeDependencies } from "./analyzers/dependencies.js";
import { analyzeExpressApi } from "./analyzers/express-api.js";
import { analyzeNestjsApi } from "./analyzers/nestjs-api.js";
import { analyzeNextjsApi } from "./analyzers/nextjs-api.js";
import { analyzeSecurity } from "./analyzers/security.js";
import { analyzeStructure } from "./analyzers/structure.js";
import { analyzeTesting } from "./analyzers/testing.js";
import { loadConfig, normalizeIgnorePatterns } from "./config.js";
import { detectStack } from "./detectors/stack-detector.js";
import type {
  AnalyzerResult,
  CodediagConfig,
  Grade,
  ScanResult,
} from "./types.js";

const WEIGHTS: Record<string, number> = {
  "API Health": 25,
  Security: 30,
  Dependencies: 20,
  Testing: 15,
  Structure: 10,
};

export interface ScanOptions {
  interactive?: boolean;
  onProgress?: (message: string) => void;
}

interface ProgressReporter {
  start(message: string): void;
  succeed(message: string): void;
}

function createProgressReporter(options: ScanOptions): ProgressReporter {
  const spinner = options.interactive === false ? null : ora({ color: "cyan" });

  return {
    start(message) {
      options.onProgress?.(message);
      spinner?.start(chalk.dim(message));
    },
    succeed(message) {
      options.onProgress?.(message);
      spinner?.succeed(chalk.dim(message));
    },
  };
}

function calculateGrade(score: number): Grade {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "B+";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export async function scan(
  projectPath: string,
  config: CodediagConfig = loadConfig(projectPath),
  options: ScanOptions = {},
): Promise<ScanResult> {
  if (!existsSync(projectPath)) {
    throw new Error(`Directory not found: ${projectPath}`);
  }

  const progress = createProgressReporter(options);
  progress.start("Detecting project stack...");

  // Detect stack
  const stack = detectStack(projectPath);
  const stackLabel = [stack.framework, stack.language, stack.orm]
    .filter(Boolean)
    .join(" + ");
  progress.succeed(`Stack: ${stackLabel}`);

  const results: AnalyzerResult[] = [];
  const ignore = normalizeIgnorePatterns(config.ignore);

  // Framework-specific API health
  if (
    config.analyzers.api &&
    (stack.framework === "nestjs" ||
      stack.framework === "express" ||
      stack.framework === "nextjs")
  ) {
    progress.start("Analyzing API health...");
    const r =
      stack.framework === "nestjs"
        ? await analyzeNestjsApi(projectPath, ignore)
        : stack.framework === "express"
          ? await analyzeExpressApi(projectPath, ignore)
          : await analyzeNextjsApi(projectPath, ignore);
    if (r) {
      results.push(r);
      progress.succeed(`API Health: ${r.score}/100`);
    } else {
      progress.succeed("API Health: not applicable");
    }
  }

  // Security
  if (config.analyzers.security) {
    progress.start("Scanning security...");
    const sec = await analyzeSecurity(projectPath, ignore);
    results.push(sec);
    progress.succeed(`Security: ${sec.score}/100`);
  }

  // Dependencies
  if (config.analyzers.dependencies) {
    progress.start("Auditing dependencies...");
    const dep = await analyzeDependencies(projectPath);
    results.push(dep);
    progress.succeed(`Dependencies: ${dep.score}/100`);
  }

  // Testing
  if (config.analyzers.testing) {
    progress.start("Checking test coverage...");
    const test = await analyzeTesting(projectPath, ignore);
    results.push(test);
    progress.succeed(`Testing: ${test.score}/100`);
  }

  // Structure
  if (config.analyzers.structure) {
    progress.start("Analyzing project structure...");
    const str = await analyzeStructure(projectPath, ignore);
    results.push(str);
    progress.succeed(`Structure: ${str.score}/100`);
  }

  // Calculate total
  let totalWeight = 0;
  let weightedSum = 0;
  for (const r of results) {
    const w = WEIGHTS[r.name] || 10;
    weightedSum += r.score * w;
    totalWeight += w;
  }

  const totalScore =
    totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const grade = calculateGrade(totalScore);

  return {
    project: basename(projectPath),
    stack,
    analyzers: results,
    totalScore,
    grade,
    timestamp: new Date().toISOString(),
  };
}
