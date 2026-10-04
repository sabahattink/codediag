import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue, PackageJson } from "../types.js";

interface AuditSummary {
  critical: number;
  high: number;
  moderate: number;
  low: number;
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

export interface AuditRun {
  stdout: string;
  stderr: string;
  error?: Error;
}

export type AuditRunner = (command: AuditCommand, cwd: string) => AuditRun;

const runAuditProcess: AuditRunner = (command, cwd) => {
  const result = spawnSync(command.command, command.args, {
    cwd,
    timeout: 30000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

type AuditOutcome =
  | { kind: "summary"; summary: AuditSummary }
  | { kind: "error"; message: string };

/**
 * Audit outcomes for this process, keyed by the command and the exact lock
 * file and package.json contents, so repeated scans (such as editor saves)
 * can reuse them without the network.
 */
const auditCache = new Map<string, AuditOutcome>();

export function clearAuditCache(): void {
  auditCache.clear();
}

function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

function auditCacheKey(
  projectPath: string,
  command: AuditCommand,
  lockFile: LockFile,
): string {
  const lockPath = lockFileNames[lockFile.manager]
    .map((name) => join(lockFile.directory, name))
    .find((candidate) => existsSync(candidate));
  return [
    command.command,
    ...command.args,
    projectPath,
    lockPath ? hashFile(lockPath) : "no-lock",
    hashFile(join(projectPath, "package.json")),
  ].join("\u0000");
}

function runAudit(
  projectPath: string,
  command: AuditCommand,
  runner: AuditRunner,
): AuditOutcome {
  const run = runner(command, projectPath);
  try {
    if (run.error) throw run.error;
    if (!run.stdout.trim()) {
      throw new Error(
        run.stderr.trim() || `${command.manager} audit returned no JSON`,
      );
    }
    return { kind: "summary", summary: parseAuditSummary(run.stdout) };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Records an audit outcome's findings and reports whether it passed. */
function recordAudit(
  outcome: AuditOutcome,
  auditCommand: AuditCommand,
  issues: DiagnosticIssue[],
): boolean {
  if (outcome.kind === "error") {
    issues.push({
      ...fromRule("audit-unavailable"),
      message: `${auditCommand.manager} audit could not be evaluated: ${outcome.message}`,
      fix: `Run ${[auditCommand.manager, ...auditCommand.args].join(" ")} and resolve the reported error`,
    });
    return false;
  }

  const { critical, high, moderate, low } = outcome.summary;
  if (critical > 0)
    issues.push({
      ...fromRule("vuln-critical"),
      message: `${critical} critical vulnerabilit${critical > 1 ? "ies" : "y"}`,
      fix: `Run ${auditCommand.fixCommand}`,
    });
  if (high > 0)
    issues.push({
      ...fromRule("vuln-high"),
      message: `${high} high severity vulnerabilit${high > 1 ? "ies" : "y"}`,
      fix: `Run ${auditCommand.fixCommand}`,
    });
  if (moderate > 0)
    issues.push({
      ...fromRule("vuln-moderate"),
      message: `${moderate} moderate vulnerabilit${moderate > 1 ? "ies" : "y"}`,
      fix: `Review ${auditCommand.manager} audit output`,
    });
  if (low > 0)
    issues.push({
      ...fromRule("vuln-low"),
      message: `${low} low severity vulnerabilit${low > 1 ? "ies" : "y"}`,
    });
  return critical + high + moderate + low === 0;
}

export interface DependencyOptions {
  /**
   * Overrides the `audit` config setting: false skips the audit, and
   * "cached" reuses an earlier result for the same lock file in this process
   * without running the package manager.
   */
  audit?: boolean | "cached";
  /** Runs the audit command; replaced in tests. */
  runAudit?: AuditRunner;
}

export async function analyzeDependencies(
  context: ScanContext,
  options: DependencyOptions = {},
): Promise<AnalyzerResult> {
  const { projectPath } = context;
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  if (context.packageJsonStatus === "missing") {
    return {
      name: "Dependencies",
      score: 0,
      issues: [
        {
          ...fromRule("no-package-json"),
          message: "No package.json found",
        },
      ],
      summary: "No package.json",
    };
  }

  const pkg: PackageJson | null = context.packageJson;
  if (!pkg) {
    return {
      name: "Dependencies",
      score: 0,
      issues: [
        {
          ...fromRule("invalid-package-json"),
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
      ...fromRule("lock-file-manager-mismatch"),
      message: `packageManager selects ${auditCommand.manager}, but the detected lock file belongs to ${lockFile.manager}`,
      fix: `Generate and commit the ${auditCommand.manager} lock file, then remove conflicting lock files`,
    });
  } else {
    issues.push({
      ...fromRule("no-lock-file"),
      message:
        "No lock file — builds are not reproducible and dependencies cannot be audited",
      fix: `Run ${auditCommand.manager} install and commit the generated lock file`,
    });
  }

  // 2. Package manager audit. Audits need a lock file; without one the
  // missing lock file is the finding and the check counts as failed. A
  // deliberately skipped audit is reported but not counted as a check.
  const auditMode = options.audit ?? context.config.audit;
  const cacheKey = lockFile
    ? auditCacheKey(projectPath, auditCommand, lockFile)
    : null;
  const cached = cacheKey ? auditCache.get(cacheKey) : undefined;
  // Without a lock file no audit can run in any mode; that is a failed check.
  if (auditMode === true || (auditMode === "cached" && (cached || !lockFile))) {
    checksRun++;
    if (lockFile && cacheKey) {
      const outcome =
        auditMode === "cached" && cached
          ? cached
          : runAudit(
              projectPath,
              auditCommand,
              options.runAudit ?? runAuditProcess,
            );
      auditCache.set(cacheKey, outcome);
      if (recordAudit(outcome, auditCommand, issues)) checksPassed++;
    }
  } else {
    issues.push({
      ...fromRule("audit-skipped"),
      message:
        auditMode === "cached"
          ? "Dependency audit has not run for this lock file yet; known vulnerabilities were not checked"
          : "Dependency audit skipped; known vulnerabilities were not checked",
      fix: `Run ${[auditCommand.manager, ...auditCommand.args].join(" ")} or scan without --no-audit`,
    });
  }

  // 3. Engines field
  checksRun++;
  if (pkg.engines?.node) {
    checksPassed++;
  } else {
    issues.push({
      ...fromRule("no-engines"),
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
      ...fromRule("missing-scripts"),
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
        ...fromRule("deprecated-dep"),
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
