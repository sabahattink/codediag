import { basename } from "path";
import { existsSync, statSync } from "fs";
import { detectStack } from "./detectors/stack-detector.js";
import { analyzeNestjsApi } from "./analyzers/nestjs-api.js";
import { analyzeSecurity } from "./analyzers/security.js";
import { analyzeDependencies } from "./analyzers/dependencies.js";
import { analyzeTesting } from "./analyzers/testing.js";
import { analyzeStructure } from "./analyzers/structure.js";
import type { AuditRunner } from "./analyzers/npm-audit.js";
import { calculateGrade, calculateTotalScore } from "./scoring.js";
import {
  DEFAULT_CONFIG,
  type AnalyzerContext,
  type AnalyzerResult,
  type CodediagConfig,
  type ProgressReporter,
  type ScanResult,
  type StackInfo,
} from "./types.js";

export interface ScanOptions {
  config?: CodediagConfig;
  progress?: ProgressReporter;
  /** Dependency audit implementation (defaults to `npm audit`); injected in tests. */
  runAudit?: AuditRunner;
}

const SILENT_PROGRESS: ProgressReporter = { start: () => {}, succeed: () => {}, stop: () => {} };

type ApiAnalyzer = (projectPath: string, ctx: AnalyzerContext) => Promise<AnalyzerResult | null>;

const API_ANALYZERS: Partial<Record<StackInfo["framework"], ApiAnalyzer>> = {
  nestjs: analyzeNestjsApi,
};

export async function scan(projectPath: string, options: ScanOptions = {}): Promise<ScanResult> {
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`Directory not found: ${projectPath}`);
  }
  const config = options.config ?? DEFAULT_CONFIG;
  const progress = options.progress ?? SILENT_PROGRESS;
  const enabled = config.analyzers;

  progress.start("Detecting project stack...");
  const stack = detectStack(projectPath);
  const ctx: AnalyzerContext = { ignore: config.ignore, stack };
  progress.succeed(`Stack: ${[stack.framework, stack.language, stack.orm].filter(Boolean).join(" + ")}`);

  const results: AnalyzerResult[] = [];
  const run = async (label: string, analyze: () => Promise<AnalyzerResult | null>): Promise<void> => {
    progress.start(`${label}...`);
    const r = await analyze();
    if (r) results.push(r);
    progress.succeed(r ? `${r.name}: ${r.score}/100` : `${label}: skipped (nothing to analyze)`);
  };

  const apiAnalyzer = API_ANALYZERS[stack.framework];
  if (enabled.api && apiAnalyzer) await run("Analyzing API health", () => apiAnalyzer(projectPath, ctx));
  if (enabled.security) await run("Scanning security", () => analyzeSecurity(projectPath, ctx));
  if (enabled.dependencies) await run("Auditing dependencies", () => analyzeDependencies(projectPath, { runAudit: options.runAudit }));
  if (enabled.testing) await run("Checking test coverage", () => analyzeTesting(projectPath, ctx));
  if (enabled.structure) await run("Analyzing project structure", () => analyzeStructure(projectPath, ctx));

  const totalScore = calculateTotalScore(results);
  return {
    project: basename(projectPath),
    stack,
    analyzers: results,
    totalScore,
    grade: calculateGrade(totalScore),
    timestamp: new Date().toISOString(),
  };
}
