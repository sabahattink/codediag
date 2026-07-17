import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { glob } from "glob";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

interface SourceRecord {
  file: string;
  content: string;
}

const SECRET_PATTERNS = [
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    name: "API Key",
  },
  {
    pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    name: "Secret/Password",
  },
  { pattern: /sk[_-](?:live|test)[_-][a-zA-Z0-9]{20,}/g, name: "Stripe Key" },
  {
    pattern: /(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,})/g,
    name: "GitHub Token",
  },
  {
    pattern:
      /(?:aws[_-]?access[_-]?key[_-]?id)\s*[:=]\s*['"]?[A-Z0-9]{20}['"]?/gi,
    name: "AWS Key",
  },
];

const RUNTIME_IGNORES = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

const RATE_LIMIT_MODULES = [
  "express-rate-limit",
  "rate-limiter-flexible",
  "@fastify/rate-limit",
  "koa-ratelimit",
];

const PASSWORD_TERM = /\b(?:password|passwd)(?:Hash|Digest)?\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function stripComments(content: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];

    if (quote) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (index < content.length && content[index] !== "\n") {
        result += " ";
        index++;
      }
      if (index < content.length) result += "\n";
      continue;
    }

    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        result += content[index] === "\n" ? "\n" : " ";
        index++;
      }
      if (index < content.length) {
        result += "  ";
        index++;
      }
      continue;
    }

    result += character;
  }

  return result;
}

function gitignorePatternMatchesEnv(pattern: string): boolean {
  let normalized = pattern.trim().replace(/\\ /g, " ");
  if (!normalized || normalized.startsWith("#")) return false;
  if (normalized.startsWith("!")) normalized = normalized.slice(1);
  normalized = normalized.replace(/^\//, "").replace(/^\*\*\//, "");
  if (normalized.includes("/")) return false;

  const expression = new RegExp(
    `^${normalized
      .split("")
      .map((character) => {
        if (character === "*") return ".*";
        if (character === "?") return ".";
        return escapeRegExp(character);
      })
      .join("")}$`,
  );
  return expression.test(".env");
}

export function gitignoreProtectsEnv(content: string): boolean {
  let ignored = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!gitignorePatternMatchesEnv(line)) continue;
    ignored = !line.startsWith("!");
  }
  return ignored;
}

function importedDefaultBindings(
  content: string,
  moduleNames: string[],
): Set<string> {
  const bindings = new Set<string>();
  for (const moduleName of moduleNames) {
    const modulePattern = escapeRegExp(moduleName);
    const patterns = [
      new RegExp(
        `\\bimport\\s+([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s+from\\s+['"]${modulePattern}['"]`,
        "g",
      ),
      new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*['"]${modulePattern}['"]\\s*\\)`,
        "g",
      ),
    ];

    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) bindings.add(match[1]);
      }
    }
  }
  return bindings;
}

function bindingIsCalled(content: string, binding: string): boolean {
  const name = escapeRegExp(binding);
  return new RegExp(`\\b${name}\\s*\\(`).test(content);
}

function bindingIsRegistered(content: string, binding: string): boolean {
  const name = escapeRegExp(binding);
  return new RegExp(`\\bregister\\s*\\(\\s*${name}\\b`).test(content);
}

function hasHelmetUsage(sources: SourceRecord[]): boolean {
  return sources.some(({ content }) => {
    const helmetBindings = importedDefaultBindings(content, ["helmet"]);
    const fastifyBindings = importedDefaultBindings(content, [
      "@fastify/helmet",
    ]);
    return (
      [...helmetBindings].some((binding) =>
        bindingIsCalled(content, binding),
      ) ||
      [...fastifyBindings].some((binding) =>
        bindingIsRegistered(content, binding),
      )
    );
  });
}

function hasRateLimitUsage(sources: SourceRecord[]): boolean {
  return sources.some(({ content }) => {
    if (
      /\bThrottlerModule\s*\.\s*forRoot(?:Async)?\s*\(/.test(content) ||
      /@\s*Throttle\s*\(/.test(content) ||
      /\bnew\s+RateLimiter[A-Za-z]*\s*\(/.test(content)
    ) {
      return true;
    }
    const factoryBindings = importedDefaultBindings(
      content,
      RATE_LIMIT_MODULES.filter(
        (moduleName) => moduleName !== "@fastify/rate-limit",
      ),
    );
    const fastifyBindings = importedDefaultBindings(content, [
      "@fastify/rate-limit",
    ]);
    return (
      [...factoryBindings].some((binding) =>
        bindingIsCalled(content, binding),
      ) ||
      [...fastifyBindings].some((binding) =>
        bindingIsRegistered(content, binding),
      )
    );
  });
}

function findOpenCors(
  sources: SourceRecord[],
): { file: string; line: number } | null {
  for (const source of sources) {
    const patterns: RegExp[] = [
      /\benableCors\s*\(\s*\)/,
      /\benableCors\s*\(\s*\{[\s\S]{0,800}?\borigin\s*:\s*(?:true|['"]\*['"])/,
    ];
    const corsBindings = importedDefaultBindings(source.content, [
      "cors",
      "@fastify/cors",
    ]);
    for (const binding of corsBindings) {
      const name = escapeRegExp(binding);
      patterns.push(
        new RegExp(`\\b${name}\\s*\\(\\s*\\)`),
        new RegExp(
          `\\b${name}\\s*\\(\\s*\\{[\\s\\S]{0,800}?\\borigin\\s*:\\s*(?:true|['"]\\*['"])`,
        ),
        new RegExp(`\\bregister\\s*\\(\\s*${name}\\s*\\)`),
        new RegExp(
          `\\bregister\\s*\\(\\s*${name}\\s*,\\s*\\{[\\s\\S]{0,800}?\\borigin\\s*:\\s*(?:true|['"]\\*['"])`,
        ),
      );
    }

    for (const pattern of patterns) {
      const match = pattern.exec(source.content);
      if (match) {
        return {
          file: source.file,
          line: lineNumberAt(source.content, match.index),
        };
      }
    }
  }
  return null;
}

function passwordIssues(sources: SourceRecord[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const persistence = /\b(?:create|insert|save|update|upsert)\s*\(/;
  const directComparison =
    /\b(?:password|passwd)(?:Hash)?\b\s*(?:===|==|!==|!=)|(?:===|==|!==|!=)\s*[^\n;]{0,80}\b(?:password|passwd)(?:Hash)?\b/i;
  const weakHash = /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i;
  const secureHash =
    /\b(?:bcrypt|bcryptjs|argon2)\s*\.\s*(?:hash|compare|verify)\s*\(|\b(?:scrypt|pbkdf2)(?:Sync)?\s*\(|\b(?:hash|verify|compare)Password\s*\(/i;

  for (const source of sources) {
    if (!PASSWORD_TERM.test(source.content)) continue;

    const weakMatch = weakHash.exec(source.content);
    if (weakMatch) {
      issues.push({
        severity: "critical",
        rule: "weak-password-hash",
        message: "Password handling uses MD5 or SHA-1",
        file: source.file,
        line: lineNumberAt(source.content, weakMatch.index),
        fix: "Hash passwords with Argon2id, scrypt, or bcrypt using an appropriate work factor",
      });
    }

    const comparisonMatch = directComparison.exec(source.content);
    if (comparisonMatch) {
      issues.push({
        severity: "critical",
        rule: "plaintext-password-comparison",
        message: "Password values appear to be compared directly",
        file: source.file,
        line: lineNumberAt(source.content, comparisonMatch.index),
        fix: "Verify passwords with a timing-safe password hashing function",
      });
    }

    const persistenceMatch = persistence.exec(source.content);
    if (persistenceMatch && !secureHash.test(source.content) && !weakMatch) {
      issues.push({
        severity: "warning",
        rule: "password-hashing-not-detected",
        message:
          "Password data may be persisted without recognizable password hashing",
        file: source.file,
        line: lineNumberAt(source.content, persistenceMatch.index),
        fix: "Hash passwords before persistence with Argon2id, scrypt, or bcrypt",
      });
    }
  }

  return issues;
}

async function readSources(
  projectPath: string,
  ignore: string[],
  runtimeOnly: boolean,
): Promise<SourceRecord[]> {
  const files = await glob("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: projectPath,
    ignore: runtimeOnly ? [...ignore, ...RUNTIME_IGNORES] : ignore,
    absolute: true,
    nodir: true,
  });
  const sources: SourceRecord[] = [];
  for (const filePath of files) {
    try {
      sources.push({
        file: relative(projectPath, filePath).replace(/\\/g, "/"),
        content: stripComments(readFileSync(filePath, "utf-8")),
      });
    } catch {
      // Files that disappear during a scan cannot be analyzed.
    }
  }
  return sources;
}

export async function analyzeSecurity(
  projectPath: string,
  ignore: string[] = ["node_modules/**", "dist/**"],
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const pkgPath = join(projectPath, "package.json");
  let dependencies: Record<string, unknown> = {};

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // Invalid package metadata is reported by the dependency analyzer.
    }
  }

  const isWebServer = [
    "@nestjs/core",
    "express",
    "fastify",
    "koa",
    "@hapi/hapi",
  ].some((name) => name in dependencies);

  checksRun++;
  {
    let foundGitignore = false;
    let directory = projectPath;
    for (let depth = 0; depth <= 3; depth++) {
      const gitignorePath = join(directory, ".gitignore");
      if (existsSync(gitignorePath)) {
        foundGitignore = true;
        const content = readFileSync(gitignorePath, "utf-8");
        if (gitignoreProtectsEnv(content)) {
          checksPassed++;
        } else {
          issues.push({
            severity: "critical",
            rule: "env-not-gitignored",
            message:
              ".env is not ignored by .gitignore — secrets may be committed",
            file: relative(projectPath, gitignorePath).replace(/\\/g, "/"),
            fix: "Add .env or .env* to your .gitignore",
          });
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!foundGitignore) {
      issues.push({
        severity: "critical",
        rule: "no-gitignore",
        message: "No .gitignore file found",
        fix: "Create .gitignore with .env, node_modules, and dist",
      });
    }
  }

  const allSources = await readSources(projectPath, ignore, false);
  const runtimeSources = await readSources(projectPath, ignore, true);

  checksRun++;
  let secretsFound = false;
  for (const source of allSources) {
    for (const { pattern, name } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(source.content);
      if (!match) continue;
      secretsFound = true;
      issues.push({
        severity: "critical",
        rule: "hardcoded-secret",
        message: `Possible ${name} found in source code`,
        file: source.file,
        line: lineNumberAt(source.content, match.index),
        fix: "Move secrets to environment variables or a secret manager",
      });
    }
  }
  if (!secretsFound) checksPassed++;

  const detectedPasswordIssues = passwordIssues(runtimeSources);
  if (
    detectedPasswordIssues.length > 0 ||
    runtimeSources.some(({ content }) => PASSWORD_TERM.test(content))
  ) {
    checksRun++;
    if (detectedPasswordIssues.length === 0) checksPassed++;
    issues.push(...detectedPasswordIssues);
  }

  if (isWebServer) {
    checksRun++;
    if (hasHelmetUsage(runtimeSources)) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "no-helmet",
        message: "Helmet middleware is not invoked in runtime source",
        fix: "Install and invoke Helmet or the framework-specific Helmet plugin",
      });
    }

    checksRun++;
    const openCors = findOpenCors(runtimeSources);
    if (!openCors) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "open-cors",
        message: "CORS is enabled without an origin allowlist",
        file: openCors.file,
        line: openCors.line,
        fix: "Set an explicit allowlist of trusted origins",
      });
    }

    checksRun++;
    if (hasRateLimitUsage(runtimeSources)) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "no-rate-limiting",
        message: "Rate limiting is not configured in runtime source",
        fix: "Configure a rate limiter appropriate for the web framework",
      });
    }
  }

  const score =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;

  return {
    name: "Security",
    score,
    issues,
    summary: `${checksPassed}/${checksRun} checks passed`,
  };
}
