import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

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
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, name: "GitHub Token" },
  {
    pattern:
      /(?:aws[_-]?access[_-]?key[_-]?id)\s*[:=]\s*['"]?[A-Z0-9]{20}['"]?/gi,
    name: "AWS Key",
  },
];

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

  // 1. .gitignore has .env — check projectPath and up to 3 parent directories (monorepo support)
  checksRun++;
  {
    let foundGitignore = false;
    let dir = projectPath;
    for (let i = 0; i <= 3; i++) {
      const gitignorePath = join(dir, ".gitignore");
      if (existsSync(gitignorePath)) {
        foundGitignore = true;
        const content = readFileSync(gitignorePath, "utf-8");
        if (content.includes(".env")) {
          checksPassed++;
        } else {
          issues.push({
            severity: "critical",
            rule: "env-not-gitignored",
            message: ".env is not in .gitignore — secrets may be committed",
            file: gitignorePath,
            fix: "Add .env to your .gitignore",
          });
        }
        break;
      }
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    if (!foundGitignore) {
      issues.push({
        severity: "critical",
        rule: "no-gitignore",
        message: "No .gitignore file found",
        fix: "Create .gitignore with .env, node_modules, dist",
      });
    }
  }

  // 2. Hardcoded secrets
  checksRun++;
  const sourceFiles = await glob("**/*.{ts,js}", {
    cwd: projectPath,
    ignore: [...ignore, "*.lock"],
    absolute: true,
  });
  let secretsFound = false;

  for (const filePath of sourceFiles.slice(0, 100)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const relFile = relative(projectPath, filePath).replace(/\\/g, "/");
      for (const { pattern, name } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          secretsFound = true;
          issues.push({
            severity: "critical",
            rule: "hardcoded-secret",
            message: `Possible ${name} found in source code`,
            file: relFile,
            fix: "Move secrets to .env and use environment variables",
          });
        }
      }
    } catch {
      /* skip */
    }
  }
  if (!secretsFound) checksPassed++;

  if (isWebServer) {
    const mainFiles = await glob("**/main.{ts,js}", {
      cwd: projectPath,
      ignore,
      absolute: true,
    });

    // 3. Helmet
    checksRun++;
    let hasHelmet = false;
    for (const file of mainFiles) {
      try {
        if (readFileSync(file, "utf-8").includes("helmet")) {
          hasHelmet = true;
          break;
        }
      } catch {
        // Unreadable source files are skipped.
      }
    }
    if (hasHelmet) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "no-helmet",
        message: "Helmet middleware not detected",
        fix: "Install helmet and configure secure HTTP headers",
      });
    }

    // 4. CORS
    checksRun++;
    let dangerousCors = false;
    for (const file of mainFiles) {
      try {
        const content = readFileSync(file, "utf-8");
        if (
          content.includes("enableCors") &&
          (content.includes("origin: '*'") ||
            content.includes('origin: "*"') ||
            content.includes("origin: true"))
        ) {
          dangerousCors = true;
        }
      } catch {
        // Unreadable source files are skipped.
      }
    }
    if (!dangerousCors) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "open-cors",
        message: "CORS configured with wildcard origin (*)",
        fix: "Set specific allowed origins",
      });
    }

    // 5. Rate limiting
    checksRun++;
    const hasRateLimit = [
      "@nestjs/throttler",
      "express-rate-limit",
      "rate-limiter-flexible",
    ].some((name) => name in dependencies);
    if (hasRateLimit) {
      checksPassed++;
    } else {
      issues.push({
        severity: "warning",
        rule: "no-rate-limiting",
        message: "No rate limiting package detected",
        fix: "Install a rate limiter appropriate for the web framework",
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
