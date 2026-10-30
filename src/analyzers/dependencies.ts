import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue, PackageJson } from "../types.js";
import {
  type AuditAdvisory,
  describeAdvisories,
  type ImporterAudit,
  parseAuditAdvisories,
  pnpmImporters,
} from "./audit-advisories.js";
import {
  auditAge,
  auditCacheFile,
  persistAudit,
  readPersistedAudit,
} from "./audit-cache.js";

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

/** Each manager's flag for auditing production dependencies only. */
const PRODUCTION_FLAGS = {
  npm: ["--omit=dev"],
  pnpm: ["--prod"],
  yarnClassic: ["--groups", "dependencies"],
  yarnModern: ["--environment", "production"],
} as const;

export function resolveAuditCommand(
  projectPath: string,
  packageManager?: string,
  production = false,
): AuditCommand {
  const only = (flags: readonly string[]) => (production ? [...flags] : []);
  const preferredManager = declaredManager(packageManager);
  const lockFile = findLockFile(projectPath, preferredManager);
  const manager = preferredManager ?? lockFile?.manager ?? "npm";
  const executable = `${manager}${process.platform === "win32" ? ".cmd" : ""}`;

  if (manager === "pnpm") {
    return {
      manager,
      command: executable,
      args: ["audit", "--json", ...only(PRODUCTION_FLAGS.pnpm)],
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
        ? [
            "npm",
            "audit",
            "--json",
            "--recursive",
            ...only(PRODUCTION_FLAGS.yarnModern),
          ]
        : ["audit", "--json", ...only(PRODUCTION_FLAGS.yarnClassic)],
      fixCommand: modern ? "yarn up <package>" : "yarn upgrade",
    };
  }

  return {
    manager,
    command: executable,
    args: ["audit", "--json", ...only(PRODUCTION_FLAGS.npm)],
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
export type AsyncAuditRunner = (
  command: AuditCommand,
  cwd: string,
) => Promise<AuditRun>;

const AUDIT_TIMEOUT_MS = 30_000;
/** Workspace audits that run at once, so a large monorepo does not flood the registry. */
const DEFAULT_AUDIT_CONCURRENCY = 4;

const runAuditProcess: AuditRunner = (command, cwd) => {
  const result = spawnSync(command.command, command.args, {
    cwd,
    timeout: AUDIT_TIMEOUT_MS,
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

const runAuditProcessAsync: AsyncAuditRunner = (command, cwd) =>
  new Promise((resolve) => {
    execFile(
      command.command,
      command.args,
      {
        cwd,
        timeout: AUDIT_TIMEOUT_MS,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === "win32",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // Audits exit non-zero when they find vulnerabilities; only a
        // process that could not start or finish is a failure, as with
        // spawnSync.
        const failed =
          error !== null && (error.killed || typeof error.code !== "number");
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          ...(failed ? { error } : {}),
        });
      },
    );
  });

type AuditOutcome =
  | {
      kind: "summary";
      summary: AuditSummary;
      advisories?: AuditAdvisory[];
      /** A pnpm workspace audit split by package; see auditScope(). */
      importers?: Record<string, ImporterAudit>;
      /** Set when the result comes from the on-disk cache: when it ran. */
      cachedAt?: number;
    }
  | { kind: "error"; message: string };

/** Where an audit runs, and which package's share of it a project reports. */
interface AuditScope {
  cwd: string;
  /** pnpm's importer id for the project, or null to report the whole audit. */
  importer: string | null;
}

/**
 * pnpm audits the whole workspace lock file from any package, so a package
 * under a shared pnpm lock file runs the audit once, at the lock file, and
 * reports only the advisories its own dependencies reach. npm and Yarn audit
 * the workspace they are run in, from the project's directory.
 */
function auditScope(
  projectPath: string,
  command: AuditCommand,
  lockFile: LockFile,
): AuditScope {
  const path = relative(lockFile.directory, projectPath);
  if (command.manager !== "pnpm" || path === "") {
    return { cwd: projectPath, importer: null };
  }
  // pnpm names importers by their path with "/" as "__": packages__api.
  return { cwd: lockFile.directory, importer: path.split(/[\\/]/).join("__") };
}

/** A project's share of an audit: the importer's advisories, or all of them. */
function shareOf(outcome: AuditOutcome, importer: string | null): AuditOutcome {
  if (importer === null || outcome.kind !== "summary" || !outcome.importers) {
    return outcome;
  }
  const own = outcome.importers[importer];
  return {
    kind: "summary",
    summary: own?.summary ?? { critical: 0, high: 0, moderate: 0, low: 0 },
    advisories: own?.advisories ?? [],
    ...(outcome.cachedAt === undefined ? {} : { cachedAt: outcome.cachedAt }),
  };
}

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

/** A successful audit from the on-disk cache, if one is fresh. */
function persistedOutcome(file: string | null): AuditOutcome | undefined {
  const persisted = file ? readPersistedAudit(file) : null;
  return persisted
    ? {
        kind: "summary",
        summary: persisted.summary,
        advisories: persisted.advisories,
        ...(persisted.importers ? { importers: persisted.importers } : {}),
        cachedAt: persisted.createdAt,
      }
    : undefined;
}

/** Keeps a successful audit for later scans; failures are retried instead. */
function persistOutcome(file: string | null, outcome: AuditOutcome): void {
  if (file && outcome.kind === "summary") {
    persistAudit(file, {
      summary: outcome.summary,
      advisories: outcome.advisories ?? [],
      ...(outcome.importers ? { importers: outcome.importers } : {}),
    });
  }
}

function auditOutcome(run: AuditRun, command: AuditCommand): AuditOutcome {
  try {
    if (run.error) throw run.error;
    if (!run.stdout.trim()) {
      throw new Error(
        run.stderr.trim() || `${command.manager} audit returned no JSON`,
      );
    }
    const importers =
      command.manager === "pnpm" ? pnpmImporters(run.stdout) : null;
    return {
      kind: "summary",
      summary: parseAuditSummary(run.stdout),
      advisories: parseAuditAdvisories(run.stdout),
      ...(importers ? { importers } : {}),
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function runAudit(
  projectPath: string,
  command: AuditCommand,
  runner: AuditRunner,
  cacheFile: string | null,
): AuditOutcome {
  const outcome = auditOutcome(runner(command, projectPath), command);
  persistOutcome(cacheFile, outcome);
  return outcome;
}

export interface AuditTarget {
  projectPath: string;
  /** Audit only production dependencies, as `audit: production` does. */
  production: boolean;
}

interface AuditJob {
  projectPath: string;
  command: AuditCommand;
  key: string;
  cacheFile: string | null;
}

function auditJob(target: AuditTarget): AuditJob | null {
  const projectPath = resolve(target.projectPath);
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf-8"));
  } catch {
    // The scan reports a missing or invalid package.json itself.
    return null;
  }
  const lockFile = findLockFile(
    projectPath,
    declaredManager(pkg.packageManager),
  );
  if (!lockFile) return null;
  const command = resolveAuditCommand(
    projectPath,
    pkg.packageManager,
    target.production,
  );
  // Packages sharing a pnpm lock file share one job, run at the lock file.
  const { cwd } = auditScope(projectPath, command, lockFile);
  const key = auditCacheKey(cwd, command, lockFile);
  return {
    projectPath: cwd,
    command,
    key,
    cacheFile: auditCacheFile(lockFile.directory, key),
  };
}

/**
 * Runs the audits of several projects concurrently, such as the packages of a
 * workspace, and keeps the outcomes for scans in this process that use
 * `audit: "cached"`. The audits are what a scan would run; only the waiting
 * overlaps.
 */
export async function prefetchAudits(
  targets: AuditTarget[],
  options: { runner?: AsyncAuditRunner; concurrency?: number } = {},
): Promise<void> {
  const runner = options.runner ?? runAuditProcessAsync;
  const jobs = [
    ...new Map(
      targets.flatMap((target) => {
        const job = auditJob(target);
        return job ? [[job.key, job] as const] : [];
      }),
    ).values(),
  ];
  let next = 0;
  const work = async (): Promise<void> => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      let outcome = persistedOutcome(job.cacheFile);
      if (!outcome) {
        outcome = auditOutcome(
          await runner(job.command, job.projectPath),
          job.command,
        );
        persistOutcome(job.cacheFile, outcome);
      }
      auditCache.set(job.key, outcome);
    }
  };
  const workers = Math.min(
    options.concurrency ?? DEFAULT_AUDIT_CONCURRENCY,
    jobs.length,
  );
  await Promise.all(Array.from({ length: workers }, work));
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
  // Affected packages go in the fix text: messages carry the finding's
  // identity for baselines and stay unchanged.
  const affected = (severity: AuditAdvisory["severity"]) =>
    describeAdvisories(outcome.advisories ?? [], severity);
  if (critical > 0)
    issues.push({
      ...fromRule("vuln-critical"),
      message: `${critical} critical vulnerabilit${critical > 1 ? "ies" : "y"}`,
      fix: `Run ${auditCommand.fixCommand}.${affected("critical")}`,
    });
  if (high > 0)
    issues.push({
      ...fromRule("vuln-high"),
      message: `${high} high severity vulnerabilit${high > 1 ? "ies" : "y"}`,
      fix: `Run ${auditCommand.fixCommand}.${affected("high")}`,
    });
  if (moderate > 0)
    issues.push({
      ...fromRule("vuln-moderate"),
      message: `${moderate} moderate vulnerabilit${moderate > 1 ? "ies" : "y"}`,
      fix: `Review ${auditCommand.manager} audit output.${affected("moderate")}`,
    });
  if (low > 0) {
    const lowAffected = affected("low");
    issues.push({
      ...fromRule("vuln-low"),
      message: `${low} low severity vulnerabilit${low > 1 ? "ies" : "y"}`,
      ...(lowAffected ? { fix: lowAffected.trim() } : {}),
    });
  }
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
  const auditCommand = resolveAuditCommand(
    projectPath,
    pkg.packageManager,
    context.config.audit === "production",
  );
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
  // `audit: production` runs the audit, limited to production dependencies.
  const auditMode = options.audit ?? context.config.audit !== false;
  const scope = lockFile
    ? auditScope(projectPath, auditCommand, lockFile)
    : null;
  const cacheKey =
    lockFile && scope ? auditCacheKey(scope.cwd, auditCommand, lockFile) : null;
  const cacheFile =
    lockFile && cacheKey && auditMode !== false
      ? auditCacheFile(lockFile.directory, cacheKey)
      : null;
  const persisted = persistedOutcome(cacheFile);
  const cached = (cacheKey ? auditCache.get(cacheKey) : undefined) ?? persisted;
  let reusedFrom: number | undefined;
  // Without a lock file no audit can run in any mode; that is a failed check.
  if (auditMode === true || (auditMode === "cached" && (cached || !lockFile))) {
    checksRun++;
    if (lockFile && scope && cacheKey) {
      // A full scan audits again unless an audit of the same lock file ran
      // within the hour; editor saves reuse any earlier result.
      const outcome =
        (auditMode === "cached" ? cached : persisted) ??
        runAudit(
          scope.cwd,
          auditCommand,
          options.runAudit ?? runAuditProcess,
          cacheFile,
        );
      auditCache.set(cacheKey, outcome);
      const own = shareOf(outcome, scope.importer);
      if (own.kind === "summary") reusedFrom = own.cachedAt;
      if (recordAudit(own, auditCommand, issues)) checksPassed++;
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
    summary: `${Math.round(checksPassed)}/${checksRun} checks passed${
      reusedFrom === undefined
        ? ""
        : `; audit reused from ${auditAge(reusedFrom)}`
    }`,
  };
}
