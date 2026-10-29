import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  /** The full parsed document, for tool-specific keys (jest, eslintConfig, prettier...). */
  raw: Record<string, unknown>;
}

export type PackageJsonResult =
  | { status: "ok"; pkg: PackageJson }
  | { status: "missing" }
  | { status: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export function readPackageJson(projectPath: string): PackageJsonResult {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return { status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return { status: "invalid" };
  }
  if (!isRecord(parsed)) return { status: "invalid" };

  return {
    status: "ok",
    pkg: {
      dependencies: stringMap(parsed.dependencies),
      devDependencies: stringMap(parsed.devDependencies),
      scripts: stringMap(parsed.scripts),
      engines: stringMap(parsed.engines),
      raw: parsed,
    },
  };
}

/** Returns package.json or null when it is missing or unparsable. */
export function readPackageJsonOrNull(projectPath: string): PackageJson | null {
  const result = readPackageJson(projectPath);
  return result.status === "ok" ? result.pkg : null;
}

export function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
}

export function hasAnyDependency(pkg: PackageJson | null, names: readonly string[]): boolean {
  const deps = allDependencies(pkg);
  return names.some((name) => name in deps);
}

/** Major version from a semver range such as "^4.21.0" or "5.x"; null when unknown ("latest", "*", git urls). */
export function majorVersion(range: string | undefined): number | null {
  if (!range) return null;
  const match = /^[\^~>=<\sv]*(\d+)/.exec(range);
  return match?.[1] ? Number(match[1]) : null;
}
