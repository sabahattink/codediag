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
import { loadConfig } from "./config.js";
import { applyBaseline } from "./core/baseline.js";
import { assignFingerprints } from "./core/fingerprint.js";
import { applyRuleOverrides } from "./core/rule-overrides.js";
import { createScanContext } from "./core/scan-context.js";
import { applyScoring } from "./core/scoring.js";
import { applySuppressions } from "./core/suppressions.js";
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
  /** Fingerprints of accepted findings, typically from loadBaseline(). */
  baseline?: ReadonlySet<string>;
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

/** Progress text; scores are final only after all analyzers have run. */
function findingCount(result: AnalyzerResult): string {
  const count = result.issues.length;
  return `${count} finding${count === 1 ? "" : "s"}`;
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
  const context = createScanContext(projectPath, config, { stack });

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
        ? await analyzeNestjsApi(context)
        : stack.framework === "express"
          ? await analyzeExpressApi(context)
          : await analyzeNextjsApi(context);
    if (r) {
      results.push(r);
      progress.succeed(`API Health: ${findingCount(r)}`);
    } else {
      progress.succeed("API Health: not applicable");
    }
  }

  // Security
  if (config.analyzers.security) {
    progress.start("Scanning security...");
    const sec = await analyzeSecurity(context);
    results.push(sec);
    progress.succeed(`Security: ${findingCount(sec)}`);
  }

  // Dependencies
  if (config.analyzers.dependencies) {
    progress.start("Auditing dependencies...");
    const dep = await analyzeDependencies(context);
    results.push(dep);
    progress.succeed(`Dependencies: ${findingCount(dep)}`);
  }

  // Testing
  if (config.analyzers.testing) {
    progress.start("Checking test coverage...");
    const test = await analyzeTesting(context);
    results.push(test);
    progress.succeed(`Testing: ${findingCount(test)}`);
  }

  // Structure
  if (config.analyzers.structure) {
    progress.start("Analyzing project structure...");
    const str = await analyzeStructure(context);
    results.push(str);
    progress.succeed(`Structure: ${findingCount(str)}`);
  }

  // Order matters: overrides run after suppressions so turning a rule off
  // does not make its directives look unused, and baselines need fingerprints.
  const configured = applyRuleOverrides(
    applySuppressions(results, context),
    config.rules,
  );
  const fingerprinted = assignFingerprints(configured, context.readText);
  const baseline = options.baseline
    ? applyBaseline(fingerprinted, options.baseline)
    : undefined;
  const analyzers = applyScoring(
    baseline?.results ?? fingerprinted,
    config.scoring.version,
  );

  // Calculate total
  let totalWeight = 0;
  let weightedSum = 0;
  for (const r of analyzers) {
    const w = WEIGHTS[r.name] || 10;
    weightedSum += r.score * w;
    totalWeight += w;
  }

  const totalScore =
    totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const grade = calculateGrade(totalScore);
  const skipped = context.skipped();

  return {
    project: basename(projectPath),
    stack,
    analyzers,
    totalScore,
    grade,
    timestamp: new Date().toISOString(),
    scoringVersion: config.scoring.version,
    ...(baseline ? { baseline: baseline.summary } : {}),
    ...(skipped.total > 0 ? { skipped } : {}),
  };
}
