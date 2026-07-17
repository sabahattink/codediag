import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  packageManager?: string;
  engines?: {
    node?: string;
  };
  scripts?: Record<string, string>;
}

type AuditManager = "npm" | "pnpm" | "yarn";

export interface AuditCommand {
  manager: AuditManager;
  command: string;
  args: string[];
  fixCommand: string;
}

interface LockFile {
  manager: AuditManager;
  directory: string;
}

const lockFileNames: Record<AuditManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
};

function findLockFile(
  projectPath: string,
  preferredManager?: AuditManager | null,
): LockFile | null {
  let directory = projectPath;
  const managers: AuditManager[] = preferredManager
    ? [
        preferredManager,
        ...(["pnpm", "yarn", "npm"] as AuditManager[]).filter(
          (manager) => manager !== preferredManager,
        ),
      ]
    : ["pnpm", "yarn", "npm"];

  for (let depth = 0; depth <= 3; depth++) {
    for (const manager of managers) {
      if (
        lockFileNames[manager].some((name) => existsSync(join(directory, name)))
      ) {
        return { manager, directory };
      }
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return null;
}

function declaredManager(value: string | undefined): AuditManager | null {
  const match = /^(npm|pnpm|yarn)@/i.exec(value ?? "");
  return (match?.[1]?.toLowerCase() as AuditManager | undefined) ?? null;
}

function isModernYarn(
  projectPath: string,
  packageManager: string | undefined,
  lockDirectory: string | undefined,
): boolean {
  const version = /^yarn@(\d+)/i.exec(packageManager ?? "")?.[1];
  if (version && Number(version) >= 2) return true;

  let directory = projectPath;
  for (let depth = 0; depth <= 3; depth++) {
    if (existsSync(join(directory, ".yarnrc.yml"))) return true;
    if (directory === lockDirectory) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return false;
}

export function resolveAuditCommand(
  projectPath: string,
  packageManager?: string,
): AuditCommand {
  const preferredManager = declaredManager(packageManager);
  const lockFile = findLockFile(projectPath, preferredManager);
  const manager = preferredManager ?? lockFile?.manager ?? "npm";
  const executable = `${manager}${process.platform === "win32" ? ".cmd" : ""}`;

  if (manager === "pnpm") {
    return {
      manager,
      command: executable,
      args: ["audit", "--json"],
      fixCommand: "pnpm audit --fix",
    };
  }

  if (manager === "yarn") {
    const modern = isModernYarn(
      projectPath,
      packageManager,
      lockFile?.directory,
    );
    return {
      manager,
      command: executable,
      args: modern
        ? ["npm", "audit", "--json", "--recursive"]
        : ["audit", "--json"],
      fixCommand: modern ? "yarn up <package>" : "yarn upgrade",
    };
  }

  return {
    manager,
    command: executable,
    args: ["audit", "--json"],
    fixCommand: "npm audit fix",
  };
}

function readVulnerabilityCounts(value: unknown): AuditSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const names: Array<keyof AuditSummary> = [
    "critical",
    "high",
    "moderate",
    "low",
  ];
  if (!names.some((name) => name in record)) return null;

  const summary = {} as AuditSummary;
  for (const name of names) {
    const count = record[name];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw new Error(`invalid ${name} vulnerability count`);
    }
    summary[name] = count;
  }
  return summary;
}

function findAuditSummary(value: unknown): AuditSummary | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const summary = findAuditSummary(entry);
      if (summary) return summary;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const metadataSummary = readVulnerabilityCounts(metadata?.vulnerabilities);
  if (metadataSummary) return metadataSummary;

  if (record.type === "auditSummary") {
    const data = record.data as Record<string, unknown> | undefined;
    const yarnSummary = readVulnerabilityCounts(data?.vulnerabilities);
    if (yarnSummary) return yarnSummary;
  }

  return null;
}

export function parseAuditSummary(output: string): AuditSummary {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("audit returned no JSON");

  try {
    const summary = findAuditSummary(JSON.parse(trimmed));
    if (summary) return summary;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Yarn Classic emits one JSON object per line.
    } else {
      throw error;
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("audit returned invalid JSON");
    }
    const summary = findAuditSummary(entry);
    if (summary) return summary;
  }

  throw new Error("audit JSON did not include a vulnerability summary");
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
  const preferredManager = declaredManager(pkg.packageManager);
  const lockFile = findLockFile(projectPath, preferredManager);
  const auditCommand = resolveAuditCommand(projectPath, pkg.packageManager);
  const hasLock =
    lockFile !== null &&
    (preferredManager === null || lockFile.manager === auditCommand.manager);
  if (hasLock) {
    checksPassed++;
  } else if (lockFile) {
    issues.push({
      severity: "critical",
      rule: "lock-file-manager-mismatch",
      message: `packageManager selects ${auditCommand.manager}, but the detected lock file belongs to ${lockFile.manager}`,
      fix: `Generate and commit the ${auditCommand.manager} lock file, then remove conflicting lock files`,
    });
  } else {
    issues.push({
      severity: "critical",
      rule: "no-lock-file",
      message: "No lock file — builds not reproducible",
      fix: `Run ${auditCommand.manager} install to generate a lock file`,
    });
  }

  // 2. Package manager audit
  checksRun++;
  const auditProcess = spawnSync(auditCommand.command, auditCommand.args, {
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
        auditProcess.stderr.trim() ||
          `${auditCommand.manager} audit returned no JSON`,
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
          fix: `Run ${auditCommand.fixCommand}`,
        });
      if (high > 0)
        issues.push({
          severity: "warning",
          rule: "vuln-high",
          message: `${high} high severity vulnerabilit${high > 1 ? "ies" : "y"}`,
          fix: `Run ${auditCommand.fixCommand}`,
        });
      if (moderate > 0)
        issues.push({
          severity: "warning",
          rule: "vuln-moderate",
          message: `${moderate} moderate vulnerabilit${moderate > 1 ? "ies" : "y"}`,
          fix: `Review ${auditCommand.manager} audit output`,
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
      message: `${auditCommand.manager} audit could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      fix: `Run ${[auditCommand.manager, ...auditCommand.args].join(" ")} and resolve the reported error`,
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
