import { existsSync, type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Minimatch } from "minimatch";
import { parse } from "yaml";

export type WorkspaceTool = "npm" | "pnpm" | "yarn" | "lerna" | "nx" | "turbo";

export interface WorkspacePackage {
  /** POSIX path relative to the workspace root. */
  path: string;
  /** The package.json name, or the Nx project name. */
  name?: string;
}

export interface WorkspaceInfo {
  tool: WorkspaceTool;
  packages: WorkspacePackage[];
}

/** Directories never searched for workspace packages. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
]);
/** How deep package directories are searched below the root. */
const MAX_DEPTH = 5;
const DEFAULT_LERNA_PACKAGES = ["packages/*"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `workspaces: [...]` (npm, Yarn) or `workspaces: { packages: [...] }` (Yarn). */
function packageJsonPatterns(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const { workspaces } = manifest;
  return isRecord(workspaces)
    ? strings(workspaces.packages)
    : strings(workspaces);
}

function pnpmPatterns(root: string): string[] {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) return [];
  try {
    const document: unknown = parse(readFileSync(path, "utf-8"));
    return isRecord(document) ? strings(document.packages) : [];
  } catch {
    return [];
  }
}

function lernaPatterns(root: string): string[] | null {
  const path = join(root, "lerna.json");
  if (!existsSync(path)) return null;
  const document = readJson(path);
  const patterns = isRecord(document) ? strings(document.packages) : [];
  return patterns.length > 0 ? patterns : DEFAULT_LERNA_PACKAGES;
}

/** Package directories below the root that hold one of the marker files. */
function candidateDirectories(root: string, markers: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string, relative: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (
      relative &&
      markers.some((marker) => entries.some((entry) => entry.name === marker))
    ) {
      found.push(relative);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walk(
        join(directory, entry.name),
        relative ? `${relative}/${entry.name}` : entry.name,
        depth + 1,
      );
    }
  };
  walk(root, "", 0);
  return found.sort();
}

/** Applies include globs and `!` exclusions, as npm and pnpm do. */
function matchPatterns(directories: string[], patterns: string[]): string[] {
  const normalize = (pattern: string) =>
    pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  const includes = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => new Minimatch(normalize(pattern)));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => new Minimatch(normalize(pattern.slice(1))));
  return directories.filter(
    (directory) =>
      includes.some((matcher) => matcher.match(directory)) &&
      !excludes.some((matcher) => matcher.match(directory)),
  );
}

function packageName(root: string, path: string): string | undefined {
  for (const file of ["package.json", "project.json"]) {
    const document = readJson(join(root, path, file));
    if (isRecord(document) && typeof document.name === "string") {
      return document.name;
    }
  }
  return undefined;
}

function packageManagerTool(root: string, manifest: unknown): WorkspaceTool {
  const declared =
    isRecord(manifest) && typeof manifest.packageManager === "string"
      ? manifest.packageManager.split("@")[0]
      : undefined;
  if (declared === "pnpm" || declared === "yarn") return declared;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * The workspace packages of a monorepo root: npm, Yarn, and pnpm workspaces,
 * Lerna packages, and Nx projects. Turborepo and Nx are reported as the tool
 * when they orchestrate the packages. Returns null for a single project.
 */
export function detectWorkspaces(root: string): WorkspaceInfo | null {
  const manifest = readJson(join(root, "package.json"));
  const isNx = existsSync(join(root, "nx.json"));
  const pnpm = pnpmPatterns(root);
  const lerna = lernaPatterns(root);
  const patterns = [
    ...packageJsonPatterns(manifest),
    ...pnpm,
    ...(lerna ?? []),
  ];

  let paths: string[];
  if (patterns.length > 0) {
    paths = matchPatterns(
      candidateDirectories(root, ["package.json"]),
      patterns,
    );
  } else if (isNx) {
    paths = candidateDirectories(root, ["project.json"]);
  } else {
    return null;
  }
  if (paths.length === 0) return null;

  const tool: WorkspaceTool = isNx
    ? "nx"
    : existsSync(join(root, "turbo.json"))
      ? "turbo"
      : lerna
        ? "lerna"
        : pnpm.length > 0
          ? "pnpm"
          : packageManagerTool(root, manifest);
  return {
    tool,
    packages: paths.map((path) => {
      const name = packageName(root, path);
      return name ? { path, name } : { path };
    }),
  };
}
