import { describe, it, expect } from "vitest";
import { calculateGrade, calculateTotalScore, exitCodeForScore, EXIT_CODES } from "../src/scoring.js";
import type { AnalyzerResult } from "../src/types.js";

function result(name: string, score: number): AnalyzerResult {
  return { name, score, issues: [], summary: "" };
}

describe("calculateGrade", () => {
  it.each([
    [100, "A+"], [95, "A+"],
    [94, "A"], [90, "A"],
    [89, "B+"], [85, "B+"],
    [84, "B"], [80, "B"],
    [79, "C"], [70, "C"],
    [69, "D"], [60, "D"],
    [59, "F"], [0, "F"],
  ])("maps %i to %s", (score, grade) => {
    expect(calculateGrade(score)).toBe(grade);
  });
});

describe("calculateTotalScore", () => {
  it("returns 0 when no analyzer ran", () => {
    expect(calculateTotalScore([])).toBe(0);
  });

  it("weights analyzers (API 25, Security 30, Deps 20, Testing 15, Structure 10)", () => {
    const all = [
      result("API Health", 100),
      result("Security", 50),
      result("Dependencies", 80),
      result("Testing", 40),
      result("Structure", 0),
    ];
    // (100*25 + 50*30 + 80*20 + 40*15 + 0*10) / 100 = 62
    expect(calculateTotalScore(all)).toBe(62);
  });

  it("re-normalizes over the analyzers that actually ran", () => {
    // (100*25 + 0*30) / 55 = 45.45 -> 45
    expect(calculateTotalScore([result("API Health", 100), result("Security", 0)])).toBe(45);
  });

  it("gives unknown analyzers a weight of 10", () => {
    // (100*10 + 0*10) / 20 = 50
    expect(calculateTotalScore([result("Custom", 100), result("Structure", 0)])).toBe(50);
  });
});

describe("exitCodeForScore", () => {
  it("passes when the score equals the threshold", () => {
    expect(exitCodeForScore(70, 70)).toBe(EXIT_CODES.ok);
  });

  it("passes above the threshold", () => {
    expect(exitCodeForScore(71, 70)).toBe(EXIT_CODES.ok);
  });

  it("fails one point below the threshold", () => {
    expect(exitCodeForScore(69, 70)).toBe(EXIT_CODES.belowThreshold);
  });

  it("never fails with a threshold of 0", () => {
    expect(exitCodeForScore(0, 0)).toBe(EXIT_CODES.ok);
  });

  it("uses distinct codes for pass, below-threshold and error", () => {
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(3);
    expect(EXIT_CODES).toEqual({ ok: 0, belowThreshold: 1, error: 2 });
  });
});
