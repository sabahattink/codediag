import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryPoint, ScanResult } from "../types.js";

/** Points kept in a report; older scans stay in the directory. */
export const MAX_HISTORY_POINTS = 50;
const HISTORY_FILE = /^codediag-[\dT-]+Z\.json$/;
const SPARK_LEVELS = "▁▂▃▄▅▆▇█";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A report's score summary, or null for anything that is not a report. */
export function historyPoint(document: unknown): HistoryPoint | null {
  if (
    !isRecord(document) ||
    typeof document.timestamp !== "string" ||
    typeof document.totalScore !== "number" ||
    typeof document.grade !== "string" ||
    !Array.isArray(document.analyzers)
  ) {
    return null;
  }
  const analyzers: Record<string, number> = {};
  for (const analyzer of document.analyzers) {
    if (
      isRecord(analyzer) &&
      typeof analyzer.name === "string" &&
      typeof analyzer.score === "number"
    ) {
      analyzers[analyzer.name] = analyzer.score;
    }
  }
  return {
    timestamp: document.timestamp,
    totalScore: document.totalScore,
    grade: document.grade,
    analyzers,
  };
}

/**
 * The reports CodeDiag recorded in a history directory, oldest first. Files
 * that are missing, unreadable, or not reports are skipped.
 */
export function loadHistory(directory: string): HistoryPoint[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => HISTORY_FILE.test(file));
  } catch {
    return [];
  }
  const points = new Map<string, HistoryPoint>();
  for (const file of files.sort().slice(-MAX_HISTORY_POINTS)) {
    try {
      const point = historyPoint(
        JSON.parse(readFileSync(join(directory, file), "utf-8")),
      );
      if (point) points.set(point.timestamp, point);
    } catch {
      // A damaged history file should not stop the scan.
    }
  }
  return [...points.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

/** Writes the report into the history directory and returns its path. */
export function recordHistory(directory: string, result: ScanResult): string {
  mkdirSync(directory, { recursive: true });
  const name = `codediag-${result.timestamp.replace(/[:.]/g, "-")}.json`;
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  return path;
}

/** The result with its score history: earlier points, then this scan. */
export function withHistory(
  result: ScanResult,
  earlier: HistoryPoint[],
): ScanResult {
  const current = historyPoint(result);
  const points = [
    ...earlier.filter((point) => point.timestamp !== result.timestamp),
    ...(current ? [current] : []),
  ].slice(-MAX_HISTORY_POINTS);
  return { ...result, history: points };
}

/** Scores 0-100 as block characters: "▃▄▄▆▇█". */
export function sparkline(scores: number[]): string {
  return scores
    .map((score) => {
      const clamped = Math.max(0, Math.min(100, score));
      const level = Math.min(
        SPARK_LEVELS.length - 1,
        Math.floor((clamped / 100) * SPARK_LEVELS.length),
      );
      return SPARK_LEVELS[level];
    })
    .join("");
}
