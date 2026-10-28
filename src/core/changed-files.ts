import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { AnalyzerResult } from "../types.js";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function gitError(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : "";
  return stderr || (error instanceof Error ? error.message : String(error));
}

/**
 * Project-relative POSIX paths of files that differ from `revision`: commits
 * since the merge base with it, staged and unstaged changes, and untracked
 * files that are not ignored. Deleted files are left out.
 */
export function changedFilesSince(
  projectPath: string,
  revision: string,
): Set<string> {
  if (!revision.trim() || revision.startsWith("-")) {
    throw new Error(`Invalid Git revision "${revision}"`);
  }

  let changed: string[];
  let topLevel: string;
  try {
    topLevel = git(projectPath, ["rev-parse", "--show-toplevel"]).trim();
    changed = [
      ...nulSeparated(
        git(projectPath, [
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=d",
          `${revision}...HEAD`,
          "--",
        ]),
      ),
      ...nulSeparated(
        git(projectPath, [
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=d",
          "HEAD",
          "--",
        ]),
      ),
      ...nulSeparated(
        git(projectPath, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--full-name",
          "-z",
        ]),
      ),
    ];
  } catch (error) {
    throw new Error(
      `Cannot list files changed since "${revision}": ${gitError(error)}`,
    );
  }

  // Git prints paths relative to the repository root.
  const projectPrefix = relative(
    realpathSync(resolve(topLevel)),
    realpathSync(resolve(projectPath)),
  )
    .split(sep)
    .join("/");
  const files = new Set<string>();
  for (const file of changed) {
    if (!projectPrefix) {
      files.add(file);
    } else if (file.startsWith(`${projectPrefix}/`)) {
      files.add(file.slice(projectPrefix.length + 1));
    }
  }
  return files;
}

/**
 * Keeps only findings located in the given files. Project-level findings
 * have no file a change could introduce, so they are left out as well.
 */
export function limitToFiles(
  results: AnalyzerResult[],
  files: ReadonlySet<string>,
): { results: AnalyzerResult[]; excluded: number } {
  let excluded = 0;
  const limited = results.map((result) => ({
    ...result,
    issues: result.issues.filter((issue) => {
      const inScope = issue.file !== undefined && files.has(issue.file);
      if (!inScope) excluded += 1;
      return inScope;
    }),
  }));
  return { results: limited, excluded };
}
