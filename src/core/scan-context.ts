import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { Minimatch } from "minimatch";
import { type CompilerOptions, Project, type SourceFile } from "ts-morph";
import { loadConfig, normalizeIgnorePatterns } from "../config.js";
import { detectStack } from "../detectors/stack-detector.js";
import type {
  CodediagConfig,
  PackageJson,
  SkippedFile,
  SkippedSummary,
  StackInfo,
} from "../types.js";

/**
 * Directory names that never contain first-party source, at any depth.
 * `build` and `out` are deliberately absent: they are often real source
 * folders, and build output there is normally covered by .gitignore.
 */
const BUILTIN_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".git",
]);

const BUILTIN_IGNORED_FILE = /\.(?:min\.(?:js|mjs|cjs)|map)$/i;
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/** Files at least this large are probed for bundler or minifier output. */
const MINIFIED_PROBE_BYTES = 32 * 1024;
const MINIFIED_AVERAGE_LINE_LENGTH = 500;
const MAX_LISTED_SKIPPED_FILES = 50;

/**
 * A child name used to ask whether an ignore pattern excludes everything
 * below a directory, mirroring glob's "children ignored" semantics.
 */
const CHILD_PROBE = "codediag-probe";

export type TypeScriptConfig =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; options: CompilerOptions };

export interface MatchOptions {
  exclude?: readonly string[];
}

export interface ScanContext {
  readonly projectPath: string;
  readonly config: CodediagConfig;
  readonly stack: StackInfo;
  readonly packageJson: PackageJson | null;
  readonly packageJsonStatus: "ok" | "missing" | "invalid";
  /** Every discovered, non-ignored, non-skipped file as a project-relative POSIX path. */
  files(): readonly string[];
  /** Discovered files matching any include glob and no exclude glob. */
  matchFiles(
    include: string | readonly string[],
    options?: MatchOptions,
  ): string[];
  absolutePath(file: string): string;
  /** Cached UTF-8 contents, or null when the file cannot be read. */
  readText(file: string): string | null;
  /** A parsed source file from the scan's single shared ts-morph project. */
  getSourceFile(file: string): SourceFile | null;
  typescriptConfig(): TypeScriptConfig;
  skipped(): SkippedSummary;
}

export interface ScanContextOptions {
  stack?: StackInfo;
}

interface GitignoreMatcher {
  matcher: Ignore;
  /** Project-relative directory that owns the file ("" for root and ancestors). */
  base: string;
  /** Path from the owning directory to the project root, for ancestor files. */
  prefix: string;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function readGitignore(directory: string): Ignore | null {
  const path = join(directory, ".gitignore");
  if (!existsSync(path)) return null;
  try {
    return ignore().add(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function findGitRoot(projectPath: string): string | null {
  let directory = projectPath;
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** .gitignore files above the project, up to and excluding the project root. */
function ancestorGitignores(projectPath: string): GitignoreMatcher[] {
  const gitRoot = findGitRoot(projectPath);
  if (!gitRoot || gitRoot === projectPath) return [];

  const directories: string[] = [];
  let directory = dirname(projectPath);
  while (true) {
    directories.unshift(directory);
    if (directory === gitRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return directories.flatMap((ancestor) => {
    const matcher = readGitignore(ancestor);
    return matcher
      ? [
          {
            matcher,
            base: "",
            prefix: toPosix(relative(ancestor, projectPath)),
          },
        ]
      : [];
  });
}

function isGitignored(
  matchers: readonly GitignoreMatcher[],
  file: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const { matcher, base, prefix } of matchers) {
    const local = base ? file.slice(base.length + 1) : file;
    const candidate = `${prefix ? `${prefix}/` : ""}${local}${isDirectory ? "/" : ""}`;
    const result = matcher.test(candidate);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function isMinified(content: string): boolean {
  let lines = 1;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines++;
  }
  return content.length / lines > MINIFIED_AVERAGE_LINE_LENGTH;
}

function readPackageJson(projectPath: string): {
  status: ScanContext["packageJsonStatus"];
  value: PackageJson | null;
} {
  const path = join(projectPath, "package.json");
  if (!existsSync(path)) return { status: "missing", value: null };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { status: "invalid", value: null };
    }
    return { status: "ok", value: value as PackageJson };
  } catch {
    return { status: "invalid", value: null };
  }
}

export function createScanContext(
  projectPath: string,
  config: CodediagConfig = loadConfig(projectPath),
  options: ScanContextOptions = {},
): ScanContext {
  const root = resolve(projectPath);
  const maxFileBytes = config.maxFileSizeKb * 1024;
  const userIgnores = normalizeIgnorePatterns(config.ignore).map(
    (pattern) => new Minimatch(pattern, { dot: true }),
  );
  const packageJson = readPackageJson(root);
  const stack = options.stack ?? detectStack(root);

  const textCache = new Map<string, string | null>();
  const sourceFileCache = new Map<string, SourceFile | null>();
  const patternCache = new Map<string, Minimatch>();
  const skippedFiles = new Map<string, SkippedFile["reason"]>();
  let index: string[] | undefined;
  let realRoot: string | undefined;
  let project: Project | undefined;
  let typescriptConfig: TypeScriptConfig | undefined;

  const absolutePath = (file: string): string => join(root, file);

  const isUserIgnored = (file: string, isDirectory: boolean): boolean =>
    userIgnores.some((pattern) =>
      pattern.match(isDirectory ? `${file}/${CHILD_PROBE}` : file),
    );

  const isInsideRoot = (path: string): boolean => {
    try {
      realRoot ??= realpathSync(root);
      const target = relative(realRoot, realpathSync(path));
      return target !== "" && !target.startsWith("..") && !isAbsolute(target);
    } catch {
      return false;
    }
  };

  const readText = (file: string): string | null => {
    if (textCache.has(file)) return textCache.get(file) ?? null;
    let content: string | null;
    try {
      content = readFileSync(absolutePath(file), "utf-8");
    } catch {
      content = null;
      skippedFiles.set(file, "unreadable");
    }
    textCache.set(file, content);
    return content;
  };

  /** Applies size and bundle limits to code files; true when the file is kept. */
  const acceptFile = (file: string, size: number): boolean => {
    if (!CODE_FILE.test(file)) return true;
    if (size > maxFileBytes) {
      skippedFiles.set(file, "too-large");
      return false;
    }
    if (size < MINIFIED_PROBE_BYTES) return true;
    const content = readText(file);
    if (content !== null && isMinified(content)) {
      textCache.delete(file);
      skippedFiles.set(file, "minified");
      return false;
    }
    return content !== null;
  };

  const walk = (
    directory: string,
    relativeDirectory: string,
    inherited: readonly GitignoreMatcher[],
    found: string[],
  ): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    const local = readGitignore(directory);
    const matchers = local
      ? [...inherited, { matcher: local, base: relativeDirectory, prefix: "" }]
      : inherited;

    for (const entry of entries) {
      // Dot entries are skipped, matching the previous glob discovery.
      if (entry.name.startsWith(".")) continue;
      const file = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const path = join(directory, entry.name);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Symlinked directories are not followed; symlinked files are kept
        // only when they resolve inside the project.
        try {
          const target = statSync(path);
          isDirectory = false;
          isFile = target.isFile() && isInsideRoot(path);
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (BUILTIN_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (isGitignored(matchers, file, true)) continue;
        if (isUserIgnored(file, true)) continue;
        walk(path, file, matchers, found);
        continue;
      }

      if (!isFile) continue;
      if (BUILTIN_IGNORED_FILE.test(entry.name)) continue;
      if (isGitignored(matchers, file, false)) continue;
      if (isUserIgnored(file, false)) continue;

      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (acceptFile(file, size)) found.push(file);
    }
  };

  const files = (): readonly string[] => {
    if (!index) {
      const found: string[] = [];
      if (existsSync(root)) walk(root, "", ancestorGitignores(root), found);
      index = found;
    }
    return index;
  };

  const compile = (pattern: string): Minimatch => {
    let compiled = patternCache.get(pattern);
    if (!compiled) {
      compiled = new Minimatch(pattern, { dot: true });
      patternCache.set(pattern, compiled);
    }
    return compiled;
  };

  const matchFiles = (
    include: string | readonly string[],
    matchOptions: MatchOptions = {},
  ): string[] => {
    const includes = (typeof include === "string" ? [include] : include).map(
      compile,
    );
    const excludes = (matchOptions.exclude ?? []).map(compile);
    return files().filter(
      (file) =>
        includes.some((pattern) => pattern.match(file)) &&
        !excludes.some((pattern) => pattern.match(file)),
    );
  };

  const getSourceFile = (file: string): SourceFile | null => {
    if (sourceFileCache.has(file)) return sourceFileCache.get(file) ?? null;
    let sourceFile: SourceFile | null = null;
    const content = readText(file);
    if (content !== null) {
      try {
        project ??= new Project({
          compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
        });
        sourceFile = project.createSourceFile(absolutePath(file), content, {
          overwrite: true,
        });
      } catch {
        sourceFile = null;
      }
    }
    sourceFileCache.set(file, sourceFile);
    return sourceFile;
  };

  const resolveTypeScriptConfig = (): TypeScriptConfig => {
    if (typescriptConfig) return typescriptConfig;
    const tsconfigPath = join(root, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      typescriptConfig = { status: "missing" };
    } else {
      try {
        const options = new Project({
          tsConfigFilePath: tsconfigPath,
          skipAddingFilesFromTsConfig: true,
        }).getCompilerOptions();
        typescriptConfig = { status: "ok", options };
      } catch {
        typescriptConfig = { status: "invalid" };
      }
    }
    return typescriptConfig;
  };

  const skipped = (): SkippedSummary => {
    const entries = [...skippedFiles.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const count = (reason: SkippedFile["reason"]) =>
      entries.filter(([, value]) => value === reason).length;
    return {
      total: entries.length,
      tooLarge: count("too-large"),
      minified: count("minified"),
      unreadable: count("unreadable"),
      files: entries
        .slice(0, MAX_LISTED_SKIPPED_FILES)
        .map(([file, reason]) => ({ file, reason })),
    };
  };

  return Object.freeze({
    projectPath: root,
    config,
    stack,
    packageJson: packageJson.value,
    packageJsonStatus: packageJson.status,
    files,
    matchFiles,
    absolutePath,
    readText,
    getSourceFile,
    typescriptConfig: resolveTypeScriptConfig,
    skipped,
  });
}
