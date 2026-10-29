import { existsSync } from "fs";
import { join } from "path";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import { allDependencies, readPackageJson } from "../utils/package-json.js";
import { runNpmAudit, type AuditRunner } from "./npm-audit.js";

const LOCK_FILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const LOCK_FILE_PARENT_LEVELS = 3;
const DEPRECATED_PACKAGES = ["request", "node-uuid", "nomnom", "coffee-script"];

export interface DependenciesOptions {
  runAudit?: AuditRunner;
}

function plural(n: number): string {
  return n > 1 ? "ies" : "y";
}

/** Lock file in projectPath or up to 3 parent directories (monorepo support). */
function hasLockFile(projectPath: string): boolean {
  let dir = projectPath;
  for (let i = 0; i <= LOCK_FILE_PARENT_LEVELS; i++) {
    if (LOCK_FILE_NAMES.some((f) => existsSync(join(dir, f)))) return true;
    const parent = join(dir, "..");
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

export async function analyzeDependencies(projectPath: string, options: DependenciesOptions = {}): Promise<AnalyzerResult> {
  const runAudit = options.runAudit ?? runNpmAudit;
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  const pkgResult = readPackageJson(projectPath);
  if (pkgResult.status === "missing") {
    return { name: "Dependencies", score: 0, issues: [{ severity: "critical", rule: "no-package-json", message: "No package.json found" }], summary: "No package.json" };
  }
  if (pkgResult.status === "invalid") {
    return { name: "Dependencies", score: 0, issues: [{ severity: "critical", rule: "invalid-package-json", message: "Cannot parse package.json" }], summary: "Invalid package.json" };
  }
  const { pkg } = pkgResult;

  // 1. Lock file
  checksRun++;
  if (hasLockFile(projectPath)) { checksPassed++; } else {
    issues.push({ severity: "critical", rule: "no-lock-file", message: "No lock file — builds not reproducible", fix: "Run npm install to generate package-lock.json" });
  }

  // 2. npm audit — half credit when the audit cannot run (offline, no npm lock file...)
  checksRun++;
  const audit = runAudit(projectPath);
  if (!audit.ok) {
    checksPassed += 0.5;
    issues.push({ severity: "info", rule: "audit-unavailable", message: `npm audit could not run: ${audit.reason}`, fix: "Run npm audit manually (requires network access and a package-lock.json)" });
  } else {
    const { critical, high, moderate } = audit.counts;
    if (critical + high + moderate === 0) {
      checksPassed++;
    } else {
      if (critical > 0) issues.push({ severity: "critical", rule: "vuln-critical", message: `${critical} critical vulnerabilit${plural(critical)}`, fix: "Run npm audit fix" });
      if (high > 0) issues.push({ severity: "warning", rule: "vuln-high", message: `${high} high severity vulnerabilit${plural(high)}`, fix: "Run npm audit fix" });
      if (moderate > 0) issues.push({ severity: "info", rule: "vuln-moderate", message: `${moderate} moderate vulnerabilit${plural(moderate)}` });
    }
  }

  // 3. Engines field
  checksRun++;
  if (pkg.engines.node) { checksPassed++; } else {
    issues.push({ severity: "info", rule: "no-engines", message: "No engines.node in package.json", fix: 'Add "engines": { "node": ">=18.0.0" }' });
  }

  // 4. Essential scripts
  checksRun++;
  if (pkg.scripts.build && (pkg.scripts.start || pkg.scripts.dev)) { checksPassed++; } else {
    issues.push({ severity: "warning", rule: "missing-scripts", message: "Missing essential scripts (build, start/dev)", fix: "Add build and start scripts" });
  }

  // 5. Deprecated deps
  checksRun++;
  const allDeps = allDependencies(pkg);
  const found = DEPRECATED_PACKAGES.filter((d) => d in allDeps);
  if (found.length === 0) { checksPassed++; } else {
    found.forEach((d) => issues.push({ severity: "warning", rule: "deprecated-dep", message: `"${d}" is deprecated` }));
  }

  const score = checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return { name: "Dependencies", score, issues, summary: `${Math.round(checksPassed)}/${checksRun} checks passed` };
}
