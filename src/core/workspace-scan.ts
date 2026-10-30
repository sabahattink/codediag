import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { prefetchAudits } from "../analyzers/dependencies.js";
import { loadConfig } from "../config.js";
import { detectStack } from "../detectors/stack-detector.js";
import { calculateGrade, type ScanOptions, scan } from "../scanner.js";
import type {
  AnalyzerResult,
  CodediagConfig,
  DiagnosticIssue,
  ScanResult,
  ScoreBreakdownEntry,
  SkippedSummary,
} from "../types.js";
import { activeIssues } from "./issues.js";
import { weightedTotal } from "./scoring.js";
import type { WorkspaceInfo } from "./workspaces.js";

const MAX_LISTED_SKIPPED_FILES = 50;

export interface WorkspaceScanOptions
  extends Omit<ScanOptions, "scope" | "fingerprintNamespace" | "label"> {
  /** Workspace-relative changed files, typically from changedFilesSince(). */
  scope?: { changedSince: string; files: ReadonlySet<string> };
  /** Overrides every package's configured `packageThreshold`. */
  packageThreshold?: number;
}

interface PackageScan {
  path: string;
  name?: string;
  result: ScanResult;
  threshold?: number;
}

/**
 * Root `ignore` entries that apply inside a package: bare names such as
 * `generated`, `**`-prefixed globs, and paths below the package, rebased.
 */
export function packageIgnores(entries: string[], path: string): string[] {
  const prefix = `${path}/`;
  return entries.flatMap((entry) => {
    const normalized = entry.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (normalized.startsWith(prefix)) return [normalized.slice(prefix.length)];
    if (!normalized.includes("/") || normalized.startsWith("**/")) {
      return [normalized];
    }
    return [];
  });
}

/**
 * A package's own .codediag.yml, or the root configuration with its ignore
 * entries rebased. Packages without a package.json (Nx projects) leave
 * dependencies to the root.
 */
function packageConfig(
  root: string,
  path: string,
  rootConfig: CodediagConfig,
): CodediagConfig {
  const directory = join(root, path);
  const config = existsSync(join(directory, ".codediag.yml"))
    ? loadConfig(directory)
    : {
        ...rootConfig,
        ignore: packageIgnores(rootConfig.ignore, path),
        analyzers: { ...rootConfig.analyzers },
      };
  if (!existsSync(join(directory, "package.json"))) {
    return {
      ...config,
      analyzers: { ...config.analyzers, dependencies: false },
    };
  }
  return config;
}

/** Changed files inside a package, relative to it. */
function packageScope(
  scope: WorkspaceScanOptions["scope"],
  path: string,
): ScanOptions["scope"] {
  if (!scope) return undefined;
  const prefix = `${path}/`;
  return {
    changedSince: scope.changedSince,
    files: new Set(
      [...scope.files]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length)),
    ),
  };
}

/**
 * Locates a finding inside the workspace. Project-level findings point at the
 * package's manifest, so every combined finding names its package.
 */
function relocate(
  issue: DiagnosticIssue,
  root: string,
  path: string,
): DiagnosticIssue {
  if (issue.file) return { ...issue, file: `${path}/${issue.file}` };
  const manifest = ["package.json", "project.json"].find((file) =>
    existsSync(join(root, path, file)),
  );
  return { ...issue, file: manifest ? `${path}/${manifest}` : path };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Points lost per rule, averaged over the packages the analyzer ran in, so
 * the entries still add up to the combined score's loss.
 */
function mergeBreakdowns(
  analyzers: AnalyzerResult[],
): ScoreBreakdownEntry[] | undefined {
  if (!analyzers.some((analyzer) => analyzer.scoreBreakdown)) return undefined;
  const merged = new Map<string, ScoreBreakdownEntry>();
  for (const analyzer of analyzers) {
    for (const entry of analyzer.scoreBreakdown ?? []) {
      const existing = merged.get(entry.rule);
      merged.set(entry.rule, {
        rule: entry.rule,
        count: (existing?.count ?? 0) + entry.count,
        penalty: (existing?.penalty ?? 0) + entry.penalty,
      });
    }
  }
  return [...merged.values()]
    .map((entry) => ({
      ...entry,
      penalty: round(entry.penalty / analyzers.length),
    }))
    .sort((left, right) => right.penalty - left.penalty);
}

function combineAnalyzer(
  name: string,
  root: string,
  scans: PackageScan[],
): AnalyzerResult {
  const runs = scans.flatMap((scan) => {
    const analyzer = scan.result.analyzers.find(
      (candidate) => candidate.name === name,
    );
    return analyzer ? [{ path: scan.path, analyzer }] : [];
  });
  const score = Math.round(
    runs.reduce((sum, run) => sum + run.analyzer.score, 0) / runs.length,
  );
  const lowest = runs.reduce((low, run) =>
    run.analyzer.score < low.analyzer.score ? run : low,
  );
  const breakdown = mergeBreakdowns(runs.map((run) => run.analyzer));
  return {
    name,
    score,
    issues: runs.flatMap((run) =>
      run.analyzer.issues.map((issue) => relocate(issue, root, run.path)),
    ),
    summary: `${runs.length} package${runs.length === 1 ? "" : "s"}; lowest: ${lowest.path} (${lowest.analyzer.score})`,
    ...(breakdown ? { scoreBreakdown: breakdown } : {}),
  };
}

function combineSkipped(scans: PackageScan[]): SkippedSummary | undefined {
  const parts = scans.flatMap((scan) =>
    scan.result.skipped
      ? [{ path: scan.path, skipped: scan.result.skipped }]
      : [],
  );
  if (parts.length === 0) return undefined;
  return {
    total: parts.reduce((sum, part) => sum + part.skipped.total, 0),
    tooLarge: parts.reduce((sum, part) => sum + part.skipped.tooLarge, 0),
    minified: parts.reduce((sum, part) => sum + part.skipped.minified, 0),
    unreadable: parts.reduce((sum, part) => sum + part.skipped.unreadable, 0),
    files: parts
      .flatMap((part) =>
        part.skipped.files.map((file) => ({
          ...file,
          file: `${part.path}/${file.file}`,
        })),
      )
      .slice(0, MAX_LISTED_SKIPPED_FILES),
  };
}

/** One report for the whole workspace, with every finding located in it. */
export function combineWorkspace(
  root: string,
  info: WorkspaceInfo,
  scans: PackageScan[],
  options: {
    scoringVersion: CodediagConfig["scoring"]["version"];
    baselineSize?: number;
    changedSince?: string;
  },
): ScanResult {
  const names = [
    ...new Set(
      scans.flatMap((scan) =>
        scan.result.analyzers.map((analyzer) => analyzer.name),
      ),
    ),
  ];
  const analyzers = names.map((name) => combineAnalyzer(name, root, scans));
  const totalScore = weightedTotal(analyzers);
  const skipped = combineSkipped(scans);
  const matched = scans.reduce(
    (sum, scan) => sum + (scan.result.baseline?.matched ?? 0),
    0,
  );

  return {
    project: basename(root),
    stack: detectStack(root),
    analyzers,
    totalScore,
    grade: calculateGrade(totalScore),
    timestamp: new Date().toISOString(),
    scoringVersion: options.scoringVersion,
    ...(options.baselineSize !== undefined
      ? { baseline: { matched, fixed: options.baselineSize - matched } }
      : {}),
    ...(skipped ? { skipped } : {}),
    ...(options.changedSince
      ? {
          scope: {
            changedSince: options.changedSince,
            files: scans.reduce(
              (sum, scan) => sum + (scan.result.scope?.files ?? 0),
              0,
            ),
            excludedFindings: scans.reduce(
              (sum, scan) => sum + (scan.result.scope?.excludedFindings ?? 0),
              0,
            ),
          },
        }
      : {}),
    workspace: {
      tool: info.tool,
      packages: scans.map((scan) => ({
        path: scan.path,
        ...(scan.name ? { name: scan.name } : {}),
        framework: scan.result.stack.framework,
        totalScore: scan.result.totalScore,
        grade: scan.result.grade,
        findings: scan.result.analyzers.reduce(
          (sum, analyzer) => sum + activeIssues(analyzer).length,
          0,
        ),
        ...(scan.threshold !== undefined ? { threshold: scan.threshold } : {}),
      })),
    },
  };
}

/**
 * Scans every workspace package with its own stack detection and
 * configuration, then combines the reports. Analyzer scores are averaged over
 * the packages they ran in, and the total uses the usual analyzer weights.
 */
export async function scanWorkspace(
  root: string,
  rootConfig: CodediagConfig,
  info: WorkspaceInfo,
  options: WorkspaceScanOptions = {},
): Promise<ScanResult> {
  const { packageThreshold, ...scanOptions } = options;
  const packages = info.packages.map((workspacePackage) => ({
    ...workspacePackage,
    config: packageConfig(root, workspacePackage.path, rootConfig),
  }));
  // Packages that would audit now run their audits concurrently up front,
  // and their scans reuse the outcomes instead of waiting one at a time.
  const audits = (config: CodediagConfig): boolean =>
    config.analyzers.dependencies &&
    (options.audit === undefined
      ? config.audit !== false
      : options.audit === true);
  await prefetchAudits(
    packages
      .filter(({ config }) => audits(config))
      .map(({ path, config }) => ({
        projectPath: join(root, path),
        production: config.audit === "production",
      })),
  );

  const scans: PackageScan[] = [];
  for (const { config, ...workspacePackage } of packages) {
    const result = await scan(join(root, workspacePackage.path), config, {
      ...scanOptions,
      ...(audits(config) ? { audit: "cached" as const } : {}),
      scope: packageScope(options.scope, workspacePackage.path),
      fingerprintNamespace: workspacePackage.path,
      label: workspacePackage.path,
    });
    // A package's own config sets its threshold only if it names one.
    const threshold =
      packageThreshold ??
      config.packageThreshold ??
      rootConfig.packageThreshold ??
      undefined;
    scans.push({
      ...workspacePackage,
      result,
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }
  return combineWorkspace(root, info, scans, {
    scoringVersion: rootConfig.scoring.version,
    baselineSize: options.baseline?.size,
    changedSince: options.scope?.changedSince,
  });
}
