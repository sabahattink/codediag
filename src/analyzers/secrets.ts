import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";

/** Configuration files that the file index discovers. */
const CONFIG_FILES = [
  "**/*.{json,jsonc,json5,yml,yaml,toml,ini,properties,xml,conf,cfg,env}",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.dockerfile",
];
const CONFIG_EXCLUDES = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/composer.lock",
  "**/{tsconfig,jsconfig}*.json",
];
/** Dot files are not indexed; these are read when Git tracks them. */
const DOT_CONFIG_FILES = /(?:^|\/)\.(?:npmrc|yarnrc|yarnrc\.yml)$/;
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/;
const TRACKED_PATHSPECS = [
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  ":(glob)**/.npmrc",
  ":(glob)**/.yarnrc",
  ":(glob)**/.yarnrc.yml",
];
const UNSCANNED_DIRECTORY = /(?:^|\/)(?:node_modules|dist|coverage)\//;
const MAX_SCANNED_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 5000;

interface ProviderPattern {
  label: string;
  pattern: RegExp;
}

/** High-precision credential formats, checked before key-value heuristics. */
const PROVIDER_PATTERNS: ProviderPattern[] = [
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { label: "Stripe key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  { label: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    label: "Slack webhook URL",
    pattern:
      /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/,
  },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: "npm token", pattern: /_auth(?:Token)?\s*=\s*(?!\$\{)[^\s$]{8,}/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    label: "OpenAI API key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/,
  },
  {
    label: "SendGrid API key",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  },
];

/** `scheme://user:password@host` with a literal password. */
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]+:([^\s@/]+)@/;
/** `key: value`, `"key": "value"`, or `KEY=value` on one line. */
const ASSIGNMENT =
  /(?<![\w$])["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^\s"'#,;}\]]+)/g;
/** Dockerfile's legacy `ENV KEY value` form. */
const DOCKER_ENV = /^\s*(?:ENV|ARG)\s+([A-Za-z_][\w.-]*)\s+["']?([^\s"']+)/;
/** Normalized key names that hold credentials, matched at the end of the key. */
const SECRET_KEY =
  /(?:password|passwd|passphrase|pwd|secret|token|apikey|privatekey|accesskey|authkey|credentials?)$/;
const PLACEHOLDER =
  /change.?me|example|your|placeholder|dummy|sample|replace|redacted|xxx|\*{3}|todo|insert|here|fake|test/i;
const REFERENCE = /\$\{|\{\{|[<>]|%\(|\$\(|^\$|process\.env/;
const FILE_REFERENCE = /^[./~]|\.(?:pem|key|crt|cer|json|txt|p12|pfx)$/i;
/** Generic values must be at least this long and this random (bits per character). */
const MIN_SECRET_LENGTH = 12;
const MIN_SECRET_ENTROPY = 3.5;

interface SecretMatch {
  line: number;
  /** A provider format such as "GitHub token". */
  label?: string;
  /** The configuration key holding a generic secret. */
  key?: string;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

/** A long, random literal rather than a placeholder, reference, or path. */
export function isLikelySecretValue(value: string): boolean {
  return (
    value.length >= MIN_SECRET_LENGTH &&
    !REFERENCE.test(value) &&
    !PLACEHOLDER.test(value) &&
    !FILE_REFERENCE.test(value) &&
    !value.includes("://") &&
    entropy(value) >= MIN_SECRET_ENTROPY
  );
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

function providerMatch(line: string): string | undefined {
  for (const { label, pattern } of PROVIDER_PATTERNS) {
    const match = pattern.exec(line);
    // AWS documentation keys end in EXAMPLE.
    if (match && !/EXAMPLE/.test(match[0])) return label;
  }
  const connection = CONNECTION_STRING.exec(line);
  if (connection?.[1] && isLikelySecretValue(connection[1])) {
    return "database password in a connection string";
  }
  return undefined;
}

function secretKey(line: string): string | undefined {
  const docker = DOCKER_ENV.exec(line);
  if (docker?.[1] && docker[2] && !docker[2].includes("=")) {
    return isSecretKey(docker[1]) && isLikelySecretValue(docker[2])
      ? docker[1]
      : undefined;
  }
  for (const [, key, value] of line.matchAll(ASSIGNMENT)) {
    if (key && value && isSecretKey(key) && isLikelySecretValue(value)) {
      return key;
    }
  }
  return undefined;
}

/** At most one match per line: a provider format first, then a secret key. */
export function findSecretsInText(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  content.split(/\r?\n/).forEach((text, index) => {
    const label = providerMatch(text);
    if (label) {
      matches.push({ line: index + 1, label });
      return;
    }
    const key = secretKey(text);
    if (key) matches.push({ line: index + 1, key });
  });
  return matches;
}

function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

function configFinding(file: string, match: SecretMatch): DiagnosticIssue {
  return {
    ...fromRule("hardcoded-secret"),
    message: match.label
      ? `Possible ${match.label} in a configuration file`
      : `Possible secret value for ${match.key} in a configuration file`,
    file,
    line: match.line,
    fix: "Remove the value, rotate it, and load it from the environment or a secret manager",
  };
}

function envFinding(file: string, match: SecretMatch): DiagnosticIssue {
  return {
    ...fromRule("committed-env-secret"),
    message: match.label
      ? `Committed .env file contains ${withArticle(match.label)}`
      : `Committed .env file contains a secret value for ${match.key}`,
    file,
    line: match.line,
    fix: "Rotate the secret, run git rm --cached on the file, and keep only a placeholder .env.example in Git",
  };
}

/**
 * Dot files tracked by Git below the project, or null when Git is unavailable
 * or the project is not in a repository.
 */
function trackedDotFiles(projectPath: string): string[] | null {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--", ...TRACKED_PATHSPECS],
      {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return output
      .split("\0")
      .filter((file) => file !== "" && !UNSCANNED_DIRECTORY.test(file));
  } catch {
    return null;
  }
}

function readDotFile(projectPath: string, file: string): string | null {
  const path = join(projectPath, file);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_SCANNED_BYTES) {
      return null;
    }
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Credentials outside source code: configuration files, Dockerfiles, npm and
 * Yarn settings, and .env files that Git tracks. Findings name the kind of
 * secret or its key, never the value.
 */
export function findConfigSecrets(context: ScanContext): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  for (const file of context.matchFiles(CONFIG_FILES, {
    exclude: CONFIG_EXCLUDES,
  })) {
    const content = context.readText(file);
    if (content === null || content.length > MAX_SCANNED_BYTES) continue;
    for (const match of findSecretsInText(content)) {
      issues.push(configFinding(file, match));
    }
  }

  const tracked = trackedDotFiles(context.projectPath);
  // Without Git, only the project's own npm and Yarn settings are read; an
  // untracked .env is the developer's local configuration.
  const dotFiles =
    tracked ??
    [".npmrc", ".yarnrc", ".yarnrc.yml"].filter((file) =>
      existsSync(join(context.projectPath, file)),
    );
  for (const file of dotFiles) {
    const isEnv = ENV_FILE.test(file);
    if (!isEnv && !DOT_CONFIG_FILES.test(file)) continue;
    const content = readDotFile(context.projectPath, file);
    if (content === null) continue;
    for (const match of findSecretsInText(content)) {
      issues.push(isEnv ? envFinding(file, match) : configFinding(file, match));
    }
  }

  return issues;
}
