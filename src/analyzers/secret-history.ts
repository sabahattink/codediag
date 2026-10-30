import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_IGNORED_DIRECTORIES,
  BUILTIN_IGNORED_FILE,
  isMinifiedCode,
  type ScanContext,
} from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";
import {
  detectSecrets,
  LOCK_FILES,
  MAX_SCANNED_BYTES,
  readScannableFile,
  trackedFiles,
  usesKeyValueHeuristics,
  withArticle,
} from "./secrets.js";

/** Starts each commit's header line; no line of diff output starts with NUL. */
const COMMIT_MARKER = "\u0000";
const COMMIT_FORMAT = "--format=%x00%H %aI";
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const SHORT_SHA_LENGTH = 7;
const GIT_TIMEOUT_MS = 5000;

/**
 * Paths that are never read, left out of `git log` so that rebuilt bundles
 * and lock files do not fill the output: built-in ignored directories,
 * minified files and source maps, and lock files.
 */
const EXCLUDED_PATHSPECS = [
  ...[...BUILTIN_IGNORED_DIRECTORIES].map(
    (name) => `:(exclude,glob)**/${name}/**`,
  ),
  ...["*.min.js", "*.min.mjs", "*.min.cjs", "*.map", ...LOCK_FILES].map(
    (name) => `:(exclude,glob)**/${name}`,
  ),
];

export interface HistoryLimits {
  /** `git log` output beyond this many bytes is not read. */
  maxBytes: number;
  timeoutMs: number;
}

export const HISTORY_LIMITS: HistoryLimits = {
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 60_000,
};

export interface HistoryCommit {
  sha: string;
  /** Author date, YYYY-MM-DD. */
  date: string;
}

export interface HistoryAddition {
  /** Index into `commits`, which are newest first. */
  commit: number;
  /** Project-relative POSIX path. */
  file: string;
  /** The lines one hunk adds, without the leading "+". */
  lines: string[];
}

export interface ParsedHistory {
  commits: HistoryCommit[];
  additions: HistoryAddition[];
}

const QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** Git's C-style quoting: `"b/we\"ird\303\244.txt"`, octal escapes are bytes. */
function unquote(text: string): string {
  const body = text.slice(1, text.lastIndexOf('"'));
  const parts: Buffer[] = [];
  let start = 0;
  for (const match of body.matchAll(/\\(?:([0-7]{3})|(.))/g)) {
    parts.push(Buffer.from(body.slice(start, match.index), "utf-8"));
    parts.push(
      match[1] !== undefined
        ? Buffer.from([Number.parseInt(match[1], 8)])
        : Buffer.from(
            QUOTED_ESCAPES[match[2] ?? ""] ?? match[2] ?? "",
            "utf-8",
          ),
    );
    start = match.index + match[0].length;
  }
  parts.push(Buffer.from(body.slice(start), "utf-8"));
  return Buffer.concat(parts).toString("utf-8");
}

/** The new path of a `+++` line, or null for a deleted file. */
function newPath(text: string): string | null {
  // Git ends a path that contains a space with a tab.
  const path = text.startsWith('"') ? unquote(text) : text.replace(/\t$/, "");
  return path.startsWith("b/") ? path.slice(2) : null;
}

/**
 * Reads one hunk's lines after its header at `lines[start]`, counting them
 * from the header so that content such as `+++ x` is never taken for a file
 * header. Returns the added lines and the index of the hunk's last line.
 */
function readHunk(
  lines: readonly string[],
  start: number,
  removed: number,
  added: number,
): { content: string[]; end: number } {
  const content: string[] = [];
  let end = start;
  let removedLeft = removed;
  let addedLeft = added;
  while (removedLeft + addedLeft > 0 && end + 1 < lines.length) {
    const line = lines[end + 1] ?? "";
    if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (line.startsWith("-") && removedLeft > 0) {
      removedLeft--;
    } else if (line.startsWith("+") && addedLeft > 0) {
      addedLeft--;
      content.push(line.slice(1).replace(/\r$/, ""));
    } else if (line.startsWith(" ")) {
      removedLeft--;
      addedLeft--;
    } else {
      break;
    }
    end++;
  }
  return { content, end };
}

/**
 * Parses `git log --patch --unified=0` output in COMMIT_FORMAT. Output cut off
 * by a size or time limit is `complete: false`: its last commit may be
 * partial, so it is dropped.
 */
export function parseGitLog(output: string, complete = true): ParsedHistory {
  const lines = output.split("\n");
  const commits: HistoryCommit[] = [];
  const additions: HistoryAddition[] = [];
  let file: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith(COMMIT_MARKER)) {
      const [sha = "", date = ""] = line.slice(1).trim().split(" ");
      commits.push({ sha, date: date.slice(0, 10) });
      file = null;
      continue;
    }
    if (commits.length === 0) continue;
    if (line.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      file = newPath(line.slice(4));
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) continue;
    const { content, end } = readHunk(
      lines,
      index,
      Number(hunk[1] ?? 1),
      Number(hunk[2] ?? 1),
    );
    index = end;
    if (file !== null && content.length > 0) {
      additions.push({ commit: commits.length - 1, file, lines: content });
    }
  }

  if (complete || commits.length === 0) return { commits, additions };
  const kept = commits.length - 1;
  return {
    commits: commits.slice(0, kept),
    additions: additions.filter((addition) => addition.commit < kept),
  };
}

interface RepositoryState {
  isShallow: boolean;
  /** The oldest commits of a shallow clone, whose diffs show their whole tree. */
  boundaryCommits: ReadonlySet<string>;
}

/** Null without Git, outside a repository, and before the first commit. */
function repositoryState(projectPath: string): RepositoryState | null {
  const result = spawnSync(
    "git",
    [
      "rev-parse",
      "--is-shallow-repository",
      "--git-path",
      "shallow",
      "--verify",
      "--quiet",
      "HEAD",
    ],
    {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || !result.stdout) return null;
  const [shallow, shallowFile = ""] = result.stdout.split(/\r?\n/);
  if (shallow !== "true") {
    return { isShallow: false, boundaryCommits: new Set() };
  }
  let boundaryCommits: string[] = [];
  try {
    boundaryCommits = readFileSync(resolve(projectPath, shallowFile), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // Without the list, boundary commits read as ordinary commits.
  }
  return { isShallow: true, boundaryCommits: new Set(boundaryCommits) };
}

/** True when the project is in a shallow clone, which has partial history. */
export function isShallowRepository(projectPath: string): boolean {
  return repositoryState(projectPath)?.isShallow === true;
}

type StopReason = "output" | "time";

interface GitLog {
  output: string;
  stopped?: StopReason;
  failed: boolean;
}

/** HEAD's history below the project, newest first, without merges. */
function readGitLog(
  projectPath: string,
  maxCommits: number,
  limits: HistoryLimits,
): GitLog {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "-c",
      "log.showSignature=false",
      "-c",
      "log.follow=false",
      "-c",
      "log.showRoot=true",
      "log",
      "HEAD",
      "--no-merges",
      // Also commits on merged branches that a merge made irrelevant.
      "--full-history",
      `--max-count=${maxCommits}`,
      "--patch",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--relative",
      COMMIT_FORMAT,
      "--",
      ".",
      ...EXCLUDED_PATHSPECS,
    ],
    {
      cwd: projectPath,
      encoding: "utf-8",
      maxBuffer: limits.maxBytes,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: limits.timeoutMs,
      windowsHide: true,
    },
  );
  const code =
    result.error && "code" in result.error ? result.error.code : undefined;
  const stopped: StopReason | undefined =
    code === "ENOBUFS" ? "output" : code === "ETIMEDOUT" ? "time" : undefined;
  return {
    output: result.stdout ?? "",
    stopped,
    failed: !stopped && result.status !== 0,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Candidate {
  file: string;
  digest: string;
  label?: string;
  key?: string;
  /** Index of the oldest commit that added the secret to the file. */
  commit: number;
  /** Where the secret is in that commit's diff, for a stable order. */
  addition: number;
  line: number;
}

function isReadable(context: ScanContext, file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return (
    !context.isExcluded(file) &&
    !BUILTIN_IGNORED_FILE.test(name) &&
    !LOCK_FILES.includes(name)
  );
}

/**
 * Secrets in added lines, one per secret and file, at the oldest commit that
 * added them. Values exist here only as digests.
 */
function findCandidates(
  context: ScanContext,
  additions: readonly HistoryAddition[],
): Candidate[] {
  const candidates = new Map<string, Candidate>();
  additions.forEach(({ commit, file, lines }, addition) => {
    if (!isReadable(context, file)) return;
    const text = lines.join("\n");
    if (text.length > MAX_SCANNED_BYTES || isMinifiedCode(file, text)) return;
    const options = { keyValues: usesKeyValueHeuristics(file) };
    for (const { index, label, key, value } of detectSecrets(lines, options)) {
      if (value === undefined) continue;
      const hash = digest(value);
      // Commits are newest first, so the last sighting is the oldest.
      candidates.set(`${hash}\u0000${file}`, {
        file,
        digest: hash,
        label,
        key,
        commit,
        addition,
        line: index,
      });
    }
  });
  return [...candidates.values()];
}

/**
 * Digests of the secrets in the candidates' files as Git tracks them now.
 * A secret that moved to another file was added there too, so only those
 * files need reading. Untracked files do not count: a .env that was removed
 * with `git rm --cached` keeps its secret on disk and in history.
 */
function currentDigests(
  projectPath: string,
  files: ReadonlySet<string>,
): Set<string> {
  const tracked = trackedFiles(projectPath);
  const trackedSet = tracked ? new Set(tracked) : null;
  const digests = new Set<string>();
  for (const file of files) {
    if (trackedSet && !trackedSet.has(file)) continue;
    const content = readScannableFile(projectPath, file);
    if (content === null) continue;
    const options = { keyValues: usesKeyValueHeuristics(file) };
    for (const { value } of detectSecrets(content.split(/\r?\n/), options)) {
      if (value !== undefined) digests.add(digest(value));
    }
  }
  return digests;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function historyFinding(
  candidate: Candidate,
  commit: HistoryCommit,
  isBoundary: boolean,
): DiagnosticIssue {
  const kind = capitalize(
    candidate.label
      ? withArticle(candidate.label)
      : `a secret value for ${candidate.key}`,
  );
  const sha = commit.sha.slice(0, SHORT_SHA_LENGTH);
  return {
    ...fromRule("secret-in-git-history"),
    message: isBoundary
      ? `${kind} was in ${candidate.file} at ${sha} (${commit.date}), the oldest commit of this shallow clone, and remains in Git history after its removal`
      : `${kind} was committed to ${candidate.file} in ${sha} (${commit.date}) and remains in Git history after its removal`,
    file: candidate.file,
    fix: "Revoke or rotate the credential: every clone and fork still contains it. Rewriting history (git filter-repo) afterwards limits further copies but does not revoke it",
  };
}

function byLocation(left: Candidate, right: Candidate): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  // Older commits have higher indexes.
  return (
    right.commit - left.commit ||
    left.addition - right.addition ||
    left.line - right.line ||
    (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function historyNote(
  scanned: number,
  maxCommits: number,
  limited: boolean,
  stopped: StopReason | undefined,
  isShallow: boolean,
): string {
  const coverage = stopped
    ? `${plural(scanned, "commit")} scanned before the ${stopped} limit`
    : limited
      ? `the most recent ${plural(maxCommits, "commit")} scanned`
      : `${plural(scanned, "commit")} scanned`;
  return `Git history: ${coverage}${isShallow ? "; shallow clone, so history is partial" : ""}`;
}

export interface SecretHistoryScan {
  issues: DiagnosticIssue[];
  /** Whether Git history was read, so the scan counts as a check. */
  scanned: boolean;
  /** What was covered, for the analyzer summary. */
  note?: string;
}

/**
 * Secrets that commits on HEAD added and that are no longer in the current
 * tree, which the other secret rules cover. Reads the most recent
 * `maxCommits` commits that touch the project. Outside a Git repository or
 * before the first commit there is nothing to read and nothing is reported.
 */
export function scanSecretHistory(
  context: ScanContext,
  maxCommits: number,
  limits: HistoryLimits = HISTORY_LIMITS,
): SecretHistoryScan {
  const repository = repositoryState(context.projectPath);
  if (!repository) return { issues: [], scanned: false };

  // One commit more than requested tells whether the limit cut history off.
  const log = readGitLog(context.projectPath, maxCommits + 1, limits);
  if (log.failed) {
    return {
      issues: [],
      scanned: false,
      note: "Git history: not scanned, git log failed",
    };
  }
  const parsed = parseGitLog(log.output, !log.stopped);
  const limited = parsed.commits.length > maxCommits;
  const commits = parsed.commits.slice(0, maxCommits);
  const additions = parsed.additions.filter(
    (addition) => addition.commit < commits.length,
  );

  const candidates = findCandidates(context, additions);
  const present = currentDigests(
    context.projectPath,
    new Set(candidates.map((candidate) => candidate.file)),
  );
  const issues = candidates
    .filter((candidate) => !present.has(candidate.digest))
    .sort(byLocation)
    .flatMap((candidate) => {
      const commit = commits[candidate.commit];
      return commit
        ? [
            historyFinding(
              candidate,
              commit,
              repository.boundaryCommits.has(commit.sha),
            ),
          ]
        : [];
    });

  if (log.stopped) {
    issues.push({
      ...fromRule("secret-history-incomplete"),
      message: `The Git history scan stopped at its ${log.stopped} limit after ${plural(commits.length, "commit")}; older commits were not checked for removed secrets`,
      fix: "Lower the number of commits in secretHistory or --secret-history until the scan completes",
    });
  }

  return {
    issues,
    scanned: true,
    note: historyNote(
      commits.length,
      maxCommits,
      limited,
      log.stopped,
      repository.isShallow,
    ),
  };
}
