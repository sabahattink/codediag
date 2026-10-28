import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseDocument } from "yaml";
import { ANALYZER_KEYS, DEFAULT_CONFIG, type AnalyzerKey, type CodediagConfig } from "./types.js";

export const CONFIG_FILE_NAMES = [".codediag.yml", ".codediag.yaml"] as const;

const TOP_LEVEL_KEYS = ["threshold", "ignore", "analyzers"] as const;

export const CONFIG_TEMPLATE = `# codediag configuration
# https://codediag.dev/docs/config

# Minimum passing score (0-100). \`codediag scan\` exits with code 1 below it.
# The --threshold flag overrides this value.
threshold: ${DEFAULT_CONFIG.threshold}

# Paths skipped by every analyzer, added to the built-in list
# (${DEFAULT_CONFIG.ignore.join(", ")}). A bare name matches at any depth,
# a path with "/" is relative to the project root, and globs are supported.
ignore:
${DEFAULT_CONFIG.ignore.map((entry) => `  - ${entry}`).join("\n")}

analyzers:
${ANALYZER_KEYS.map((key) => `  ${key}: true`).join("\n")}
`;

/** Thrown for invalid configuration or CLI options; the CLI exits with code 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: CodediagConfig;
  /** Absolute path of the file that was read, or null when defaults are used. */
  path: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

function parseIgnore(value: unknown, problems: string[]): string[] {
  if (!Array.isArray(value)) {
    problems.push("ignore must be a list of strings");
    return [];
  }
  const entries: string[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(`ignore[${index}] must be a non-empty string`);
      return;
    }
    entries.push(entry.trim());
  });
  return entries;
}

function parseAnalyzers(value: unknown, problems: string[]): Partial<Record<AnalyzerKey, boolean>> {
  if (!isPlainObject(value)) {
    problems.push("analyzers must be a mapping of analyzer name to true/false");
    return {};
  }
  const toggles: Partial<Record<AnalyzerKey, boolean>> = {};
  for (const [name, enabled] of Object.entries(value)) {
    const key = ANALYZER_KEYS.find((k) => k === name);
    if (!key) {
      problems.push(`Unknown analyzer "${name}" (allowed: ${ANALYZER_KEYS.join(", ")})`);
      continue;
    }
    if (enabled === null) continue;
    if (typeof enabled !== "boolean") {
      problems.push(`analyzers.${name} must be true or false`);
      continue;
    }
    toggles[key] = enabled;
  }
  return toggles;
}

/**
 * Parses and validates the text of a `.codediag.yml` file and merges it over
 * DEFAULT_CONFIG. Keys with no value are treated as unset. All problems are
 * reported in a single ConfigError.
 */
export function parseConfig(text: string, source = ".codediag.yml"): CodediagConfig {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const details = doc.errors.map((e) => e.message.split("\n")[0]).join("\n  ");
    throw new ConfigError(`${source}: invalid YAML\n  ${details}`);
  }

  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) return structuredClone(DEFAULT_CONFIG);
  if (!isPlainObject(raw)) {
    throw new ConfigError(`Invalid ${source}:\n  - the document must be a mapping (key: value pairs)`);
  }

  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.some((k) => k === key)) {
      problems.push(`Unknown key "${key}" (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
    }
  }

  let threshold = DEFAULT_CONFIG.threshold;
  if (raw.threshold !== undefined && raw.threshold !== null) {
    if (isValidThreshold(raw.threshold)) threshold = raw.threshold;
    else problems.push("threshold must be an integer between 0 and 100");
  }

  const extraIgnore = raw.ignore === undefined || raw.ignore === null ? [] : parseIgnore(raw.ignore, problems);
  const toggles = raw.analyzers === undefined || raw.analyzers === null ? {} : parseAnalyzers(raw.analyzers, problems);
  const analyzers = { ...DEFAULT_CONFIG.analyzers, ...toggles };

  if (!ANALYZER_KEYS.some((key) => analyzers[key])) {
    problems.push("at least one analyzer must be enabled");
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid ${source}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return {
    threshold,
    ignore: [...new Set([...DEFAULT_CONFIG.ignore, ...extraIgnore])],
    analyzers,
  };
}

/** Returns the config file in `projectPath`, or null. Both extensions present is an error. */
export function findConfigFile(projectPath: string): string | null {
  const found = CONFIG_FILE_NAMES.map((name) => join(projectPath, name)).filter((p) => existsSync(p));
  if (found.length > 1) {
    throw new ConfigError(`Both ${CONFIG_FILE_NAMES.join(" and ")} found in ${projectPath}; keep only one`);
  }
  return found[0] ?? null;
}

/** Loads `.codediag.yml` / `.codediag.yaml` from the scanned directory, or the defaults. */
export function loadConfig(projectPath: string): LoadedConfig {
  const path = findConfigFile(projectPath);
  if (!path) return { config: structuredClone(DEFAULT_CONFIG), path: null };

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ConfigError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  return { config: parseConfig(text, path), path };
}

/** Validates the raw `--threshold` flag value. */
export function parseThreshold(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 100) {
    throw new ConfigError(`--threshold must be an integer between 0 and 100 (got "${value}")`);
  }
  return Number(value);
}

/** Threshold precedence: CLI flag > config file > default. */
export function resolveThreshold(cliValue: string | undefined, config: CodediagConfig): number {
  return cliValue === undefined ? config.threshold : parseThreshold(cliValue);
}
