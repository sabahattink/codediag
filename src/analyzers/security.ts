import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  type CallExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import { scanSecretHistory } from "./secret-history.js";
import { findConfigSecrets, isPlaceholderValue } from "./secrets.js";
import { analyzeSecuritySinks } from "./security-sinks.js";

interface SourceRecord {
  file: string;
  content: string;
}

interface SecretPattern {
  pattern: RegExp;
  name: string;
  /** Whether the captured value is a secret rather than a message or placeholder. */
  accepts?: (value: string) => boolean;
  /** Skipped in test files. */
  runtimeOnly?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    name: "API Key",
  },
  {
    pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
    name: "Secret/Password",
    // Passwords in tests are fixtures; provider tokens still count there.
    runtimeOnly: true,
    // "Password is required" is a message, "testpassword" a placeholder.
    accepts: (value: string) => !/\s/.test(value) && !isPlaceholderValue(value),
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

const SOURCE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

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
/** A value holding a password or its stored hash. */
const PASSWORD_VALUE = /^(?:password|passwd)(?:Hash)?$/i;
/** The second entry of a sign-up or change-password form. */
const PASSWORD_CHECK = /confirm|repeat|retype|again/i;
const EQUALITY_OPERATORS = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);
const PERSIST_METHODS = new Set([
  "create",
  "createMany",
  "insert",
  "insertOne",
  "insertMany",
  "save",
  "update",
  "updateOne",
  "updateMany",
  "upsert",
]);
/** A key in written data that holds the password itself. */
const PASSWORD_KEY = /^["']?(?:password|passwd)["']?$/i;
/** The Pwned Passwords range API, which takes a SHA-1 prefix by design. */
const PWNED_RANGE_API = /api\.pwnedpasswords\.com\/range/;

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

/**
 * Local names for one named export: `import { cors as c } from "hono/cors"`
 * or `const { cors } = require("hono/cors")`.
 */
function importedNamedBindings(
  content: string,
  moduleName: string,
  exportName: string,
): Set<string> {
  const bindings = new Set<string>();
  const modulePattern = escapeRegExp(moduleName);
  const lists = [
    new RegExp(
      `\\bimport\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${modulePattern}['"]`,
      "g",
    ),
    new RegExp(
      `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${modulePattern}['"]\\s*\\)`,
      "g",
    ),
  ];
  for (const pattern of lists) {
    for (const match of content.matchAll(pattern)) {
      for (const entry of (match[1] ?? "").split(",")) {
        const [imported, local] = entry
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+|\s*:\s*/);
        if (imported === exportName) bindings.add(local ?? imported);
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
    const honoBindings = importedNamedBindings(
      content,
      "hono/secure-headers",
      "secureHeaders",
    );
    return (
      [...helmetBindings, ...honoBindings].some((binding) =>
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
    const honoBindings = importedNamedBindings(
      content,
      "hono-rate-limiter",
      "rateLimiter",
    );
    return (
      [...factoryBindings, ...honoBindings].some((binding) =>
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
    // Hono's cors() allows every origin when no origin option is given.
    const corsBindings = new Set([
      ...importedDefaultBindings(source.content, ["cors", "@fastify/cors"]),
      ...importedNamedBindings(source.content, "hono/cors", "cors"),
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

/** The name a compared or persisted value goes by: `password`, `user.password`. */
function valueName(node: Node): string | null {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isPropertyAccessExpression(node)) return node.getName();
  return null;
}

/** A value that is a constant or a type test, not another credential. */
function isConstantOperand(node: Node): boolean {
  return (
    Node.isLiteralExpression(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isTypeOfExpression(node) ||
    node.getText() === "undefined"
  );
}

/**
 * `user.password === password`: a stored and a supplied password compared
 * as values. Type and length checks, comparisons with constants, and the
 * sign-up form's `password !== confirmPassword` are validation.
 */
function passwordComparison(sourceFile: SourceFile): Node | undefined {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .find((binary) => {
      if (
        !EQUALITY_OPERATORS.has(binary.getOperatorToken().getKind()) ||
        [binary.getLeft(), binary.getRight()].some(isConstantOperand)
      ) {
        return false;
      }
      const names = [binary.getLeft(), binary.getRight()].map(valueName);
      return (
        names.some((name) => name !== null && PASSWORD_VALUE.test(name)) &&
        !names.some((name) => name !== null && PASSWORD_CHECK.test(name))
      );
    });
}

/** A write whose data carries a password: `create({ data: { email, password } })`. */
function passwordWrite(sourceFile: SourceFile): CallExpression | undefined {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => {
      const name = valueName(call.getExpression());
      return (
        name !== null &&
        PERSIST_METHODS.has(name) &&
        call.getDescendants().some(isRawPassword)
      );
    });
}

/**
 * A `password` key holding the value as it came in: shorthand, a variable,
 * or a property. A call (`createPassword(input)`) or a nested relation write
 * gets the benefit of the doubt, since hashing goes through a function.
 */
function isRawPassword(node: Node): boolean {
  if (Node.isShorthandPropertyAssignment(node)) {
    return PASSWORD_KEY.test(node.getName());
  }
  if (!Node.isPropertyAssignment(node) || !PASSWORD_KEY.test(node.getName())) {
    return false;
  }
  const value = node.getInitializer();
  return (
    value !== undefined &&
    (Node.isIdentifier(value) ||
      Node.isPropertyAccessExpression(value) ||
      Node.isElementAccessExpression(value))
  );
}

function passwordIssues(
  context: ScanContext,
  sources: SourceRecord[],
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const weakHash = /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i;
  const secureHash =
    /\b(?:bcrypt|bcryptjs|argon2)\s*\.\s*(?:hash|compare|verify)\s*\(|\b(?:scrypt|pbkdf2)(?:Sync)?\s*\(|\b(?:hash|verify|compare)Password\s*\(|\b(?:get|create|make|generate|compute)Password(?:Hash|Digest)\s*\(/i;

  for (const source of sources) {
    if (!PASSWORD_TERM.test(source.content)) continue;
    const sourceFile = context.getSourceFile(source.file);

    const weakMatch = PWNED_RANGE_API.test(source.content)
      ? null
      : weakHash.exec(source.content);
    if (weakMatch) {
      issues.push({
        ...fromRule("weak-password-hash"),
        message: "Password handling uses MD5 or SHA-1",
        file: source.file,
        line: lineNumberAt(source.content, weakMatch.index),
        fix: "Hash passwords with Argon2id, scrypt, or bcrypt using an appropriate work factor",
      });
    }

    // A file that does not parse cannot be judged by its syntax.
    if (!sourceFile) continue;

    const comparison = passwordComparison(sourceFile);
    if (comparison) {
      issues.push({
        ...fromRule("plaintext-password-comparison"),
        message: "Password values appear to be compared directly",
        file: source.file,
        line: comparison.getStartLineNumber(),
        fix: "Verify passwords with a timing-safe password hashing function",
      });
    }

    const write = passwordWrite(sourceFile);
    if (write && !secureHash.test(source.content) && !weakMatch) {
      issues.push({
        ...fromRule("password-hashing-not-detected"),
        message:
          "Password data may be persisted without recognizable password hashing",
        file: source.file,
        line: write.getStartLineNumber(),
        fix: "Hash passwords before persistence with Argon2id, scrypt, or bcrypt",
      });
    }
  }

  return issues;
}

function readSources(context: ScanContext): {
  allSources: SourceRecord[];
  runtimeSources: SourceRecord[];
} {
  const runtimeFiles = new Set(
    context.matchFiles(SOURCE_PATTERN, { exclude: RUNTIME_IGNORES }),
  );
  const allSources: SourceRecord[] = [];
  const runtimeSources: SourceRecord[] = [];
  for (const file of context.matchFiles(SOURCE_PATTERN)) {
    const content = context.readText(file);
    // Files that cannot be read are reported in the scan's skipped summary.
    if (content === null) continue;
    const source = { file, content: stripComments(content) };
    allSources.push(source);
    if (runtimeFiles.has(file)) runtimeSources.push(source);
  }
  return { allSources, runtimeSources };
}

export interface SecurityOptions {
  /**
   * Overrides the `secretHistory` config setting: a number of commits to
   * search, or false to leave Git history alone.
   */
  secretHistory?: false | number;
}

export async function analyzeSecurity(
  context: ScanContext,
  options: SecurityOptions = {},
): Promise<AnalyzerResult> {
  const { projectPath } = context;
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  // Invalid package metadata is reported by the dependency analyzer.
  const dependencies: Record<string, unknown> = {
    ...context.packageJson?.dependencies,
    ...context.packageJson?.devDependencies,
  };

  const isWebServer = [
    "@nestjs/core",
    "express",
    "fastify",
    "hono",
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
            ...fromRule("env-not-gitignored"),
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
        ...fromRule("no-gitignore"),
        message: "No .gitignore file found",
        fix: "Create .gitignore with .env, node_modules, and dist",
      });
    }
  }

  const { allSources, runtimeSources } = readSources(context);

  checksRun++;
  let secretsFound = false;
  const runtimeFiles = new Set(runtimeSources.map(({ file }) => file));
  for (const source of allSources) {
    for (const { pattern, name, accepts, runtimeOnly } of SECRET_PATTERNS) {
      if (runtimeOnly && !runtimeFiles.has(source.file)) continue;
      pattern.lastIndex = 0;
      // A value built with ${...} interpolation is not a hardcoded secret.
      const match = [...source.content.matchAll(pattern)].find(
        (candidate) =>
          !candidate[0].includes("${") &&
          (accepts?.(candidate[1] ?? "") ?? true),
      );
      if (!match || match.index === undefined) continue;
      secretsFound = true;
      issues.push({
        ...fromRule("hardcoded-secret"),
        message: `Possible ${name} found in source code`,
        file: source.file,
        line: lineNumberAt(source.content, match.index),
        fix: "Move secrets to environment variables or a secret manager",
      });
    }
  }
  const configSecrets = findConfigSecrets(context);
  issues.push(...configSecrets);
  if (!secretsFound && configSecrets.length === 0) checksPassed++;

  // Opt-in: results depend on clone depth, so they would make local and CI
  // baselines differ.
  const secretHistory = options.secretHistory ?? context.config.secretHistory;
  let historyNote: string | undefined;
  if (secretHistory !== false) {
    const history = scanSecretHistory(context, secretHistory);
    if (history.scanned) {
      checksRun++;
      if (!history.issues.some((issue) => issue.severity !== "info")) {
        checksPassed++;
      }
    }
    issues.push(...history.issues);
    historyNote = history.note;
  }

  const detectedPasswordIssues = passwordIssues(context, runtimeSources);
  if (
    detectedPasswordIssues.length > 0 ||
    runtimeSources.some(({ content }) => PASSWORD_TERM.test(content))
  ) {
    checksRun++;
    if (detectedPasswordIssues.length === 0) checksPassed++;
    issues.push(...detectedPasswordIssues);
  }

  checksRun++;
  const sinkIssues = await analyzeSecuritySinks(context);
  if (sinkIssues.length === 0) checksPassed++;
  issues.push(...sinkIssues);

  if (isWebServer) {
    checksRun++;
    if (hasHelmetUsage(runtimeSources)) {
      checksPassed++;
    } else {
      issues.push({
        ...fromRule("no-helmet"),
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
        ...fromRule("open-cors"),
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
        ...fromRule("no-rate-limiting"),
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
    summary: `${checksPassed}/${checksRun} checks passed${historyNote ? `; ${historyNote}` : ""}`,
  };
}
