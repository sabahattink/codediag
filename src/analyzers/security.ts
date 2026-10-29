import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue, StackInfo } from "../types.js";
import { findFiles } from "../utils/files.js";
import { hasAnyDependency, readPackageJsonOrNull } from "../utils/package-json.js";

interface SecretPattern {
  pattern: RegExp;
  name: string;
}

// Patterns with a `value` group are checked against PLACEHOLDER_VALUE to skip obvious dummies.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"](?<value>[a-zA-Z0-9_\-]{20,})['"]/gi, name: "API Key" },
  { pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"](?<value>[^'"]{8,})['"]/gi, name: "Secret/Password" },
  { pattern: /sk[_-](?:live|test)[_-][a-zA-Z0-9]{20,}/g, name: "Stripe Key" },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, name: "GitHub Token" },
  { pattern: /(?:aws[_-]?access[_-]?key[_-]?id)\s*[:=]\s*['"]?[A-Z0-9]{20}['"]?/gi, name: "AWS Key" },
];

const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|(?:your|my|insert|enter|replace)[-_ ]?\S*|change[-_ ]?me|placeholder|example\S*|dummy\S*|redacted)$/i;

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";
const MAX_SCANNED_FILE_BYTES = 1_000_000;

/** Frameworks that run their own HTTP server, where helmet/CORS middleware applies. */
const SERVER_FRAMEWORKS: ReadonlySet<StackInfo["framework"]> = new Set(["nestjs", "express"]);
/** Frameworks that serve HTTP endpoints, where rate limiting and password hashing apply. */
const WEB_FRAMEWORKS: ReadonlySet<StackInfo["framework"]> = new Set(["nestjs", "express", "nextjs"]);

const RATE_LIMIT_PACKAGES = ["@nestjs/throttler", "express-rate-limit", "rate-limiter-flexible", "@upstash/ratelimit"];
const HASHING_PACKAGES = ["bcrypt", "bcryptjs", "argon2", "@node-rs/argon2", "@node-rs/bcrypt"];

const HELMET_USAGE = /(?:from\s+['"](?:helmet|@fastify\/helmet)['"]|require\(\s*['"]helmet['"]\s*\))/;
const WILDCARD_CORS = [
  /\borigin\s*:\s*(?:['"`]\*['"`]|true)/, // { origin: '*' } / { origin: true }
  /\bcors\s*:\s*true\b/, // NestFactory.create(AppModule, { cors: true })
  /\benableCors\(\s*\)/, // app.enableCors() — defaults to *
  /\bcors\(\s*\)/, // app.use(cors()) — defaults to *
];

interface SourceText {
  file: string;
  content: string;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function findSecret(content: string, { pattern }: SecretPattern): number | null {
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const value = match.groups?.value;
    if (value !== undefined && PLACEHOLDER_VALUE.test(value)) continue;
    return lineOf(content, match.index ?? 0);
  }
  return null;
}

async function readSources(projectPath: string, ctx: AnalyzerContext): Promise<SourceText[]> {
  const files = await findFiles(projectPath, SOURCE_GLOB, ctx.ignore, ["**/*.d.ts", "**/*.min.js"]);
  const sources: SourceText[] = [];
  for (const file of files) {
    const abs = join(projectPath, file);
    try {
      if (statSync(abs).size > MAX_SCANNED_FILE_BYTES) continue;
      sources.push({ file, content: readFileSync(abs, "utf-8") });
    } catch { /* unreadable file: skip */ }
  }
  return sources;
}

function isTestFile(file: string): boolean {
  return /(?:\.(?:spec|test)\.|\.e2e-spec\.|(?:^|\/)__tests__\/)/.test(file);
}

function checkGitignore(projectPath: string, issues: DiagnosticIssue[]): boolean {
  // .gitignore in projectPath or up to 3 parent directories (monorepo support)
  let dir = projectPath;
  for (let i = 0; i <= 3; i++) {
    const gitignorePath = join(dir, ".gitignore");
    if (existsSync(gitignorePath)) {
      if (readFileSync(gitignorePath, "utf-8").includes(".env")) return true;
      issues.push({ severity: "critical", rule: "env-not-gitignored", message: ".env is not in .gitignore — secrets may be committed", file: gitignorePath, fix: "Add .env to your .gitignore" });
      return false;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  issues.push({ severity: "critical", rule: "no-gitignore", message: "No .gitignore file found", fix: "Create .gitignore with .env, node_modules, dist" });
  return false;
}

export async function analyzeSecurity(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const pass = (ok: boolean): void => {
    checksRun++;
    if (ok) checksPassed++;
  };

  // 1. .gitignore has .env
  pass(checkGitignore(projectPath, issues));

  // 2. Hardcoded secrets (every source file not excluded by `ignore`)
  const sources = await readSources(projectPath, ctx);
  let secretsFound = false;
  for (const { file, content } of sources) {
    for (const secret of SECRET_PATTERNS) {
      const line = findSecret(content, secret);
      if (line === null) continue;
      secretsFound = true;
      issues.push({ severity: "critical", rule: "hardcoded-secret", message: `Possible ${secret.name} found in source code`, file, line, fix: "Move secrets to .env and use environment variables" });
    }
  }
  pass(!secretsFound);

  const framework = ctx.stack.framework;
  const appSources = sources.filter((s) => !isTestFile(s.file));

  if (SERVER_FRAMEWORKS.has(framework)) {
    // 3. Helmet
    const hasHelmet = appSources.some((s) => HELMET_USAGE.test(s.content));
    pass(hasHelmet);
    if (!hasHelmet) {
      issues.push({ severity: "warning", rule: "no-helmet", message: "Helmet middleware not detected", fix: "Install helmet and add app.use(helmet()) where the app is created" });
    }

    // 4. CORS
    const openCors = appSources.find((s) => /cors/i.test(s.content) && WILDCARD_CORS.some((re) => re.test(s.content)));
    pass(!openCors);
    if (openCors) {
      issues.push({ severity: "warning", rule: "open-cors", message: "CORS allows any origin (*)", file: openCors.file, fix: "Set specific allowed origins" });
    }
  }

  if (WEB_FRAMEWORKS.has(framework)) {
    const pkg = readPackageJsonOrNull(projectPath);

    // 5. Rate limiting
    const hasRateLimit = hasAnyDependency(pkg, RATE_LIMIT_PACKAGES);
    pass(hasRateLimit);
    if (!hasRateLimit) {
      issues.push({ severity: "warning", rule: "no-rate-limiting", message: "No rate limiting package detected", fix: `Install one of: ${RATE_LIMIT_PACKAGES.join(", ")}` });
    }

    // 6. Password hashing
    const hasHashing = hasAnyDependency(pkg, HASHING_PACKAGES);
    pass(hasHashing);
    if (!hasHashing) {
      issues.push({ severity: "info", rule: "no-password-hashing", message: "No password hashing library detected", fix: "Install argon2 or bcryptjs if handling passwords" });
    }
  }

  const score = checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return { name: "Security", score, issues, summary: `${checksPassed}/${checksRun} checks passed` };
}
