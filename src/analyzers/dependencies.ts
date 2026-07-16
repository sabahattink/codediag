import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

interface AuditSummary {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: {
    node?: string;
  };
  scripts?: Record<string, string>;
}

export function parseAuditSummary(output: string): AuditSummary {
  const audit = JSON.parse(output) as {
    metadata?: {
      vulnerabilities?: Partial<Record<keyof AuditSummary, unknown>>;
    };
  };
  const vulnerabilities = audit.metadata?.vulnerabilities ?? {};
  const readCount = (name: keyof AuditSummary): number => {
    const value = vulnerabilities[name];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  return {
    critical: readCount("critical"),
    high: readCount("high"),
    moderate: readCount("moderate"),
    low: readCount("low"),
  };
}

export async function analyzeDependencies(
  projectPath: string,
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      name: "Dependencies",
      score: 0,
      issues: [
        {
          severity: "critical",
          rule: "no-package-json",
          message: "No package.json found",
        },
      ],
      summary: "No package.json",
    };
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return {
      name: "Dependencies",
      score: 0,
      issues: [
        {
          severity: "critical",
          rule: "invalid-package-json",
          message: "Cannot parse package.json",
        },
      ],
      summary: "Invalid package.json",
    };
  }

  // 1. Lock file — check projectPath and up to 3 parent directories (monorepo support)
  checksRun++;
  const lockFileNames = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  let hasLock = false;
  {
    let dir = projectPath;
    for (let i = 0; i <= 3; i++) {
      if (lockFileNames.some((f) => existsSync(join(dir, f)))) {
        hasLock = true;
        break;
      }
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (hasLock) {
    checksPassed++;
  } else {
    issues.push({
      severity: "critical",
      rule: "no-lock-file",
      message: "No lock file — builds not reproducible",
      fix: "Run npm install to generate package-lock.json",
    });
  }

  // 2. npm audit
  checksRun++;
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const auditProcess = spawnSync(npmCommand, ["audit", "--json"], {
    cwd: projectPath,
    timeout: 30000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  try {
    if (auditProcess.error) throw auditProcess.error;
    if (!auditProcess.stdout.trim()) {
      throw new Error(
        auditProcess.stderr.trim() || "npm audit returned no JSON",
      );
    }

    const { critical, high, moderate, low } = parseAuditSummary(
      auditProcess.stdout,
    );
    if (critical + high + moderate + low === 0) {
      checksPassed++;
    } else {
      if (critical > 0)
        issues.push({
          severity: "critical",
          rule: "vuln-critical",
          message: `${critical} critical vulnerabilit${critical > 1 ? "ies" : "y"}`,
          fix: "Run npm audit fix",
        });
      if (high > 0)
        issues.push({
          severity: "warning",
          rule: "vuln-high",
          message: `${high} high severity vulnerabilit${high > 1 ? "ies" : "y"}`,
          fix: "Run npm audit fix",
        });
      if (moderate > 0)
        issues.push({
          severity: "warning",
          rule: "vuln-moderate",
          message: `${moderate} moderate vulnerabilit${moderate > 1 ? "ies" : "y"}`,
          fix: "Review npm audit output",
        });
      if (low > 0)
        issues.push({
          severity: "info",
          rule: "vuln-low",
          message: `${low} low severity vulnerabilit${low > 1 ? "ies" : "y"}`,
        });
    }
  } catch (error) {
    issues.push({
      severity: "warning",
      rule: "audit-unavailable",
      message: `npm audit could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Run npm audit --json and resolve the reported error",
    });
  }

  // 3. Engines field
  checksRun++;
  if (pkg.engines?.node) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-engines",
      message: "No engines.node in package.json",
      fix: 'Add "engines": { "node": ">=18.0.0" }',
    });
  }

  // 4. Essential scripts
  checksRun++;
  if (pkg.scripts?.build && (pkg.scripts?.start || pkg.scripts?.dev)) {
    checksPassed++;
  } else {
    issues.push({
      severity: "warning",
      rule: "missing-scripts",
      message: "Missing essential scripts (build, start/dev)",
      fix: "Add build and start scripts",
    });
  }

  // 5. Deprecated deps
  checksRun++;
  const risky = ["request", "node-uuid", "nomnom", "coffee-script"];
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const found = risky.filter((d) => d in allDeps);
  if (found.length === 0) {
    checksPassed++;
  } else {
    for (const dependency of found) {
      issues.push({
        severity: "warning",
        rule: "deprecated-dep",
        message: `"${dependency}" is deprecated`,
      });
    }
  }

  const score =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return {
    name: "Dependencies",
    score,
    issues,
    summary: `${Math.round(checksPassed)}/${checksRun} checks passed`,
  };
}
