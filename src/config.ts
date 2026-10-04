import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getRule } from "./rules/registry.js";
import {
  type AnalyzerKey,
  type CodediagConfig,
  DEFAULT_CONFIG,
  type RuleSetting,
  type ScoringVersion,
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

function readThreshold(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw new Error("threshold must be an integer between 0 and 100");
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

function readAudit(value: unknown): boolean {
  if (value === undefined) return DEFAULT_CONFIG.audit;
  if (typeof value !== "boolean")
    throw new Error("audit must be true or false");
  return value;
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
      ignore: [...DEFAULT_CONFIG.ignore],
      maxFileSizeKb: DEFAULT_CONFIG.maxFileSizeKb,
      scoring: { ...DEFAULT_CONFIG.scoring },
      rules: {},
      audit: DEFAULT_CONFIG.audit,
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
    "ignore",
    "maxFileSizeKb",
    "scoring",
    "rules",
    "audit",
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
      ignore: readIgnore(document.ignore, DEFAULT_CONFIG.ignore),
      maxFileSizeKb: readMaxFileSizeKb(
        document.maxFileSizeKb,
        DEFAULT_CONFIG.maxFileSizeKb,
      ),
      scoring: readScoring(document.scoring, DEFAULT_CONFIG.scoring),
      rules: readRules(document.rules),
      audit: readAudit(document.audit),
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

export function parseThreshold(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("threshold must be an integer between 0 and 100");
  }
  return readThreshold(Number(value), DEFAULT_CONFIG.threshold);
}

export function isBelowThreshold(score: number, threshold: number): boolean {
  return score < threshold;
}
