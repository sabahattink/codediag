import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { activeIssues } from "./core/issues.js";
import { getRule } from "./rules/registry.js";
import {
  type AnalyzerKey,
  type AnalyzerResult,
  type CodediagConfig,
  DEFAULT_CONFIG,
  DEFAULT_SECRET_HISTORY_COMMITS,
  MAX_SECRET_HISTORY_COMMITS,
  type DiagnosticIssue,
  type RuleSetting,
  type ScoringVersion,
  type WorkspacePackageSummary,
  type WorkspaceSummary,
} from "./types.js";

const ANALYZER_KEYS: AnalyzerKey[] = [
  "api",
  "security",
  "dependencies",
  "testing",
  "structure",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThreshold<T>(
  value: unknown,
  fallback: T,
  name = "threshold",
): number | T {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw new Error(`${name} must be an integer between 0 and 100`);
  }
  return Number(value);
}

function readIgnore(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error("ignore must be an array of non-empty strings");
  }
  return value.map((entry) => entry.trim());
}

const MAX_FILE_SIZE_KB_LIMIT = 1024 * 1024;

function readMaxFileSizeKb(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_FILE_SIZE_KB_LIMIT
  ) {
    throw new Error(
      `maxFileSizeKb must be an integer between 1 and ${MAX_FILE_SIZE_KB_LIMIT}`,
    );
  }
  return Number(value);
}

const SCORING_VERSIONS: ScoringVersion[] = [1, 2];

function readScoring(
  value: unknown,
  fallback: CodediagConfig["scoring"],
): CodediagConfig["scoring"] {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) {
    throw new Error("scoring must be an object");
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "version");
  if (unknownKeys.length > 0) {
    throw new Error(`unknown scoring option: ${unknownKeys.join(", ")}`);
  }
  if (value.version === undefined) return { ...fallback };
  if (!SCORING_VERSIONS.includes(value.version as ScoringVersion)) {
    throw new Error("scoring.version must be 1 or 2");
  }
  return { version: value.version as ScoringVersion };
}

const RULE_SETTINGS: RuleSetting[] = ["off", "info", "warning", "critical"];

function readRules(value: unknown): Record<string, RuleSetting> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error("rules must be a map of rule IDs to settings");
  }
  const rules: Record<string, RuleSetting> = {};
  for (const [id, setting] of Object.entries(value)) {
    if (!getRule(id)) {
      throw new Error(`unknown rule: ${id} (see docs/rules.md)`);
    }
    // YAML 1.1 parsers read a bare `off` as false; accept both spellings.
    const normalized = setting === false ? "off" : setting;
    if (!RULE_SETTINGS.includes(normalized as RuleSetting)) {
      throw new Error(`rules.${id} must be one of ${RULE_SETTINGS.join(", ")}`);
    }
    rules[id] = normalized as RuleSetting;
  }
  return rules;
}

/** Severities from least to most severe. */
const SEVERITIES: Array<DiagnosticIssue["severity"]> = [
  "info",
  "warning",
  "critical",
];

function readFailOn(value: unknown, name = "failOn"): CodediagConfig["failOn"] {
  if (value === undefined || value === null) return null;
  if (!SEVERITIES.includes(value as DiagnosticIssue["severity"])) {
    throw new Error(`${name} must be critical, warning, or info`);
  }
  return value as DiagnosticIssue["severity"];
}

function readAudit(value: unknown): CodediagConfig["audit"] {
  if (value === undefined) return DEFAULT_CONFIG.audit;
  if (typeof value !== "boolean" && value !== "production")
    throw new Error("audit must be true, false, or production");
  return value;
}

function isCommitCount(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= MAX_SECRET_HISTORY_COMMITS
  );
}

function readSecretHistory(value: unknown): CodediagConfig["secretHistory"] {
  if (value === undefined || value === false) return false;
  if (value === true) return DEFAULT_SECRET_HISTORY_COMMITS;
  if (!isCommitCount(value)) {
    throw new Error(
      `secretHistory must be true, false, or a number of commits from 1 to ${MAX_SECRET_HISTORY_COMMITS}`,
    );
  }
  return value;
}

/** `--secret-history` without a value is true; with one, a commit count. */
export function parseSecretHistory(value: string | true): number {
  if (value === true) return DEFAULT_SECRET_HISTORY_COMMITS;
  const count = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!isCommitCount(count)) {
    throw new Error(
      `--secret-history must be a number of commits from 1 to ${MAX_SECRET_HISTORY_COMMITS}`,
    );
  }
  return count;
}

function readAnalyzers(
  value: unknown,
  fallback: CodediagConfig["analyzers"],
): CodediagConfig["analyzers"] {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) {
    throw new Error("analyzers must be an object");
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !ANALYZER_KEYS.includes(key as AnalyzerKey),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`unknown analyzer: ${unknownKeys.join(", ")}`);
  }

  const analyzers = { ...fallback };
  for (const key of ANALYZER_KEYS) {
    const setting = value[key];
    if (setting === undefined) continue;
    if (typeof setting !== "boolean") {
      throw new Error(`analyzers.${key} must be true or false`);
    }
    analyzers[key] = setting;
  }
  return analyzers;
}

export function loadConfig(projectPath: string): CodediagConfig {
  const configPath = join(projectPath, ".codediag.yml");
  if (!existsSync(configPath)) {
    return {
      threshold: DEFAULT_CONFIG.threshold,
      packageThreshold: DEFAULT_CONFIG.packageThreshold,
      failOn: DEFAULT_CONFIG.failOn,
      ignore: [...DEFAULT_CONFIG.ignore],
      maxFileSizeKb: DEFAULT_CONFIG.maxFileSizeKb,
      scoring: { ...DEFAULT_CONFIG.scoring },
      rules: {},
      audit: DEFAULT_CONFIG.audit,
      secretHistory: DEFAULT_CONFIG.secretHistory,
      analyzers: { ...DEFAULT_CONFIG.analyzers },
    };
  }

  let document: unknown;
  try {
    document = parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid .codediag.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document === null || document === undefined) document = {};
  if (!isRecord(document)) {
    throw new Error("Invalid .codediag.yml: root must be an object");
  }

  const allowedKeys = new Set([
    "threshold",
    "packageThreshold",
    "failOn",
    "ignore",
    "maxFileSizeKb",
    "scoring",
    "rules",
    "audit",
    "secretHistory",
    "analyzers",
  ]);
  const unknownKeys = Object.keys(document).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid .codediag.yml: unknown option: ${unknownKeys.join(", ")}`,
    );
  }

  try {
    return {
      threshold: readThreshold(document.threshold, DEFAULT_CONFIG.threshold),
      packageThreshold: readThreshold(
        document.packageThreshold,
        DEFAULT_CONFIG.packageThreshold,
        "packageThreshold",
      ),
      failOn: readFailOn(document.failOn),
      ignore: readIgnore(document.ignore, DEFAULT_CONFIG.ignore),
      maxFileSizeKb: readMaxFileSizeKb(
        document.maxFileSizeKb,
        DEFAULT_CONFIG.maxFileSizeKb,
      ),
      scoring: readScoring(document.scoring, DEFAULT_CONFIG.scoring),
      rules: readRules(document.rules),
      audit: readAudit(document.audit),
      secretHistory: readSecretHistory(document.secretHistory),
      analyzers: readAnalyzers(document.analyzers, DEFAULT_CONFIG.analyzers),
    };
  } catch (error) {
    throw new Error(
      `Invalid .codediag.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeIgnorePatterns(entries: string[]): string[] {
  return entries.flatMap((entry) => {
    const normalized = entry
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .replace(/\/+$/, "");
    if (/[*?[\]{}()!]/.test(normalized)) return [normalized];
    return [normalized, `${normalized}/**`];
  });
}

export function parseThreshold(value: string, name = "threshold"): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between 0 and 100`);
  }
  return readThreshold(Number(value), DEFAULT_CONFIG.threshold, name);
}

export function isBelowThreshold(score: number, threshold: number): boolean {
  return score < threshold;
}

export function parseFailOn(value: string): DiagnosticIssue["severity"] {
  return readFailOn(value, "fail-on") ?? "critical";
}

/** Active findings that fail a scan with this `failOn` severity. */
export function findingsAtOrAbove(
  analyzers: AnalyzerResult[],
  failOn: CodediagConfig["failOn"],
): DiagnosticIssue[] {
  if (failOn === null) return [];
  const minimum = SEVERITIES.indexOf(failOn);
  return analyzers
    .flatMap(activeIssues)
    .filter((issue) => SEVERITIES.indexOf(issue.severity) >= minimum);
}

export function failOnMessage(
  count: number,
  failOn: DiagnosticIssue["severity"],
): string {
  return `${count} active finding${count === 1 ? "" : "s"} at or above ${failOn} severity`;
}

/** Workspace packages that scored below their package threshold. */
export function packagesBelowThreshold(
  workspace: WorkspaceSummary | undefined,
): WorkspacePackageSummary[] {
  return (workspace?.packages ?? []).filter(
    (entry) =>
      entry.threshold !== undefined &&
      isBelowThreshold(entry.totalScore, entry.threshold),
  );
}

export function packageThresholdMessage(
  entry: WorkspacePackageSummary,
): string {
  return `${entry.path} scored ${entry.totalScore}, below its package threshold ${entry.threshold}`;
}
