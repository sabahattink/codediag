import { glob } from "glob";
import { toGlobIgnore } from "./ignore.js";

/** Globs that identify test and declaration files (excluded from "source" walks). */
export const TEST_AND_DECLARATION_GLOBS: readonly string[] = [
  "**/*.{spec,test}.*",
  "**/*.e2e-spec.*",
  "**/__tests__/**",
  "**/*.d.ts",
];

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Finds files under `projectPath` matching `patterns`, honouring the config
 * `ignore` entries plus any extra glob ignores. Returns sorted project-relative
 * POSIX paths so analyzer output is deterministic.
 */
export async function findFiles(
  projectPath: string,
  patterns: string | readonly string[],
  ignore: readonly string[],
  extraIgnoreGlobs: readonly string[] = []
): Promise<string[]> {
  const files = await glob(typeof patterns === "string" ? patterns : [...patterns], {
    cwd: projectPath,
    ignore: [...toGlobIgnore(ignore), ...extraIgnoreGlobs],
    nodir: true,
    posix: true,
  });
  return files.map(toPosix).sort();
}

/** Lists the immediate sub-directories of `dir` (project-relative), honouring `ignore`. */
export async function findSubdirectories(projectPath: string, dir: string, ignore: readonly string[]): Promise<string[]> {
  const entries = await glob(`${dir}/*`, {
    cwd: projectPath,
    ignore: toGlobIgnore(ignore),
    mark: true,
    posix: true,
  });
  return entries
    .map(toPosix)
    .filter((e) => e.endsWith("/"))
    .map((e) => e.slice(0, -1))
    .sort();
}
