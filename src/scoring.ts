import type { AnalyzerResult } from "./types.js";

export const ANALYZER_WEIGHTS: Readonly<Record<string, number>> = {
  "API Health": 25,
  "Security": 30,
  "Dependencies": 20,
  "Testing": 15,
  "Structure": 10,
};

const DEFAULT_ANALYZER_WEIGHT = 10;

export const EXIT_CODES = {
  ok: 0,
  belowThreshold: 1,
  error: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function calculateGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "B+";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** Weighted average of the analyzers that ran, re-normalized over their weights. */
export function calculateTotalScore(results: readonly AnalyzerResult[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const r of results) {
    const w = ANALYZER_WEIGHTS[r.name] ?? DEFAULT_ANALYZER_WEIGHT;
    weightedSum += r.score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

export function exitCodeForScore(score: number, threshold: number): ExitCode {
  return score >= threshold ? EXIT_CODES.ok : EXIT_CODES.belowThreshold;
}
