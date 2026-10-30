import { basename, isAbsolute, relative, resolve } from "node:path";
import { Minimatch } from "minimatch";
import { activeIssues } from "../../../src/core/issues.js";
import type { ScanContext } from "../../../src/core/scan-context.js";
import { applySuppressions } from "../../../src/core/suppressions.js";
import {
  getRule,
  RULES_DOCUMENT_URL,
  ruleDocsUrl,
} from "../../../src/rules/registry.js";
import type { DiagnosticIssue, ScanResult } from "../../../src/types.js";

export interface EditorDiagnostic {
  analyzer: string;
  severity: DiagnosticIssue["severity"];
  rule: string;
  message: string;
  filePath: string;
  /** 0-based; findings without a line are shown on the first line. */
  line: number;
  fix?: string;
  /** The finding names a file but no line. */
  fileLevel?: true;
}

export interface DiagnosticSummary {
  diagnostics: EditorDiagnostic[];
  fileless: number;
  outsideWorkspace: number;
}

function resolveWorkspaceFile(
  workspaceRoot: string,
  issueFile: string,
): string | null {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, issueFile);
  const pathFromRoot = relative(root, candidate);

  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    return null;
  }

  return candidate;
}

export function collectEditorDiagnostics(
  result: ScanResult,
  workspaceRoot: string,
): DiagnosticSummary {
  const diagnostics: EditorDiagnostic[] = [];
  let fileless = 0;
  let outsideWorkspace = 0;

  for (const analyzer of result.analyzers) {
    for (const issue of activeIssues(analyzer)) {
      if (!issue.file) {
        fileless += 1;
        continue;
      }

      const filePath = resolveWorkspaceFile(workspaceRoot, issue.file);
      if (!filePath) {
        outsideWorkspace += 1;
        continue;
      }

      diagnostics.push({
        analyzer: analyzer.name,
        severity: issue.severity,
        rule: issue.rule,
        message: issue.message,
        filePath,
        line: Math.max(0, (issue.line ?? 1) - 1),
        ...(issue.fix ? { fix: issue.fix } : {}),
        ...(issue.line === undefined ? { fileLevel: true as const } : {}),
      });
    }
  }

  return { diagnostics, fileless, outsideWorkspace };
}

export function countSeverities(result: ScanResult): {
  critical: number;
  warning: number;
  info: number;
} {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const analyzer of result.analyzers) {
    for (const issue of activeIssues(analyzer)) counts[issue.severity] += 1;
  }
  return counts;
}

/** The rule's section of docs/rules.md, whose headings are the rule IDs. */
export function ruleDocumentationUrl(rule: string): string {
  return getRule(rule) ? ruleDocsUrl(rule) : RULES_DOCUMENT_URL;
}

export type SuppressionScope = "line" | "file";

/** What a suppression quick fix needs to know about its finding. */
export interface SuppressionRequest {
  scope: SuppressionScope;
  filePath: string;
  rule: string;
  /** 0-based line of the finding. */
  line: number;
  fileLevel: boolean;
}

/** A directive line, inserted as a snippet with the cursor where the reason goes. */
export interface SuppressionEdit {
  scope: SuppressionScope;
  rule: string;
  /** 0-based line the directive is inserted before. */
  line: number;
  snippet: string;
}

/** A replacement within one line that removes the cause of a finding. */
export interface RemediationEdit {
  /** 0-based line of the finding. */
  line: number;
  start: number;
  end: number;
  text: string;
}

export type QuickFix =
  | { kind: "remediate"; title: string; edit: RemediationEdit }
  | { kind: "suppress"; title: string; request: SuppressionRequest }
  | { kind: "explain"; title: string; url: string };

interface Remediation {
  title: string;
  /** The fix within the finding's line, or null when it is not mechanical there. */
  rewrite(line: string): Omit<RemediationEdit, "line"> | null;
}

/** The single match of a global pattern on a line; two matches are ambiguous. */
function onlyMatch(line: string, pattern: RegExp): RegExpExecArray | null {
  const matches = [...line.matchAll(pattern)];
  return matches.length === 1 ? (matches[0] as RegExpExecArray) : null;
}

function replaceFlag(
  line: string,
  pattern: RegExp,
  value: string,
): Omit<RemediationEdit, "line"> | null {
  const match = onlyMatch(line, pattern);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: `${match[1]}${value}`,
  };
}

const NONE_ALGORITHM = /^(["'`])none\1$/i;

/**
 * Rules whose fix is the same everywhere and fits on the finding's line.
 * Each rewrite matches the exact syntax the analyzer reports, so a line
 * that changed since the scan or holds the setting twice gets no fix.
 */
const REMEDIATIONS: Readonly<Record<string, Remediation>> = {
  "tls-verification-disabled": {
    title: "Enable TLS certificate verification",
    rewrite: (line) =>
      replaceFlag(line, /\b(rejectUnauthorized["']?\s*:\s*)false\b/g, "true"),
  },
  "jwt-expiration-ignored": {
    title: "Verify the token's expiration time",
    rewrite: (line) =>
      replaceFlag(line, /\b(ignoreExpiration["']?\s*:\s*)true\b/g, "false"),
  },
  "jwt-none-algorithm": {
    title: 'Stop accepting the "none" algorithm',
    rewrite(line) {
      // Only literal lists that keep at least one real algorithm.
      const match = onlyMatch(line, /\b(algorithms["']?\s*:\s*\[)([^\]]*)\]/g);
      if (!match) return null;
      const inner = match[2] ?? "";
      const elements = inner.split(",").map((element) => element.trim());
      const kept = elements.filter((element) => !NONE_ALGORITHM.test(element));
      const literal = (element: string) => /^(["'`]).*\1$/.test(element);
      if (
        kept.length === elements.length ||
        kept.length === 0 ||
        !elements.every(literal)
      ) {
        return null;
      }
      const padding = /^\s*/.exec(inner)?.[0] ?? "";
      const trailing = /\s*$/.exec(inner)?.[0] ?? "";
      return {
        start: match.index,
        end: match.index + match[0].length,
        text: `${match[1]}${padding}${kept.join(", ")}${trailing}]`,
      };
    },
  },
};

function remediation(finding: EditorDiagnostic, text: string): QuickFix | null {
  const rule = REMEDIATIONS[finding.rule];
  if (!rule || finding.fileLevel) return null;
  const line = text.split(/\r?\n/)[finding.line];
  const rewrite = line === undefined ? null : rule.rewrite(line);
  return rewrite
    ? {
        kind: "remediate",
        title: rule.title,
        edit: { line: finding.line, ...rewrite },
      }
    : null;
}

const SCOPES: readonly SuppressionScope[] = ["line", "file"];
const DIRECTIVES: Record<SuppressionScope, string> = {
  line: "codediag-ignore-next-line",
  file: "codediag-ignore-file",
};
const SCOPE_LABELS: Record<SuppressionScope, string> = {
  line: "on this line",
  file: "in this file",
};
/** Stands in for the reason the user types when checking the scanner applies a directive. */
const PROBE_REASON = "reason";

/**
 * Findings about directives are added after suppressions apply, so no
 * directive can suppress them; the fix is to correct the directive.
 */
const DIRECTIVE_RULES = new Set([
  "suppression-missing-reason",
  "unused-suppression",
]);

const compiledPatterns = new Map<string, Minimatch>();

function matchesPattern(pattern: string, file: string): boolean {
  let compiled = compiledPatterns.get(pattern);
  if (!compiled) {
    compiled = new Minimatch(pattern, { dot: true });
    compiledPatterns.set(pattern, compiled);
  }
  return compiled.match(file);
}

/**
 * Runs the scanner's own suppression pass over one in-memory file, so quick
 * fixes agree with the CLI on directive syntax and on which files it reads
 * directives from. The pass reads files only through `matchFiles` and
 * `readText`.
 */
function scannerSuppresses(
  filePath: string,
  text: string,
  rule: string,
  line: number | undefined,
): boolean {
  const file = basename(filePath);
  const context: Pick<ScanContext, "matchFiles" | "readText"> = {
    matchFiles: (include) =>
      [include].flat().some((pattern) => matchesPattern(pattern, file))
        ? [file]
        : [],
    readText: () => text,
  };
  const issue: DiagnosticIssue = {
    severity: "info",
    rule,
    message: rule,
    file,
    ...(line === undefined ? {} : { line: line + 1 }),
  };
  const [result] = applySuppressions(
    [{ name: "CodeDiag", score: 0, summary: "", issues: [issue] }],
    context as ScanContext,
  );
  return result?.issues[0]?.suppression !== undefined;
}

/**
 * The first line after the shebang and the leading comments, which must stay
 * first for pragmas such as Jest docblocks; null when no code line follows.
 */
function afterLeadingComments(lines: readonly string[]): number | null {
  let index = lines[0]?.startsWith("#!") ? 1 : 0;
  let inBlock = false;
  for (; index < lines.length; index += 1) {
    const text = (lines[index] ?? "").trim();
    if (inBlock) {
      inBlock = !text.includes("*/");
      continue;
    }
    if (text === "" || text.startsWith("//")) continue;
    if (!text.startsWith("/*")) break;
    const end = text.indexOf("*/", 2);
    if (end === -1) inBlock = true;
    else if (text.slice(end + 2).trim() !== "") break;
  }
  return index < lines.length ? index : null;
}

interface Insertion {
  line: number;
  indent: string;
}

function insertionFor(
  request: SuppressionRequest,
  lines: readonly string[],
): Insertion | null {
  if (request.scope === "file") {
    const line = afterLeadingComments(lines);
    return line === null ? null : { line, indent: "" };
  }
  const target = request.fileLevel ? undefined : lines[request.line];
  if (target === undefined) return null;
  return { line: request.line, indent: /^[ \t]*/.exec(target)?.[0] ?? "" };
}

function directiveLine(
  request: SuppressionRequest,
  indent: string,
  reason: string,
): string {
  return `${indent}// ${DIRECTIVES[request.scope]} ${request.rule} -- ${reason}`;
}

function escapeSnippet(text: string): string {
  return text.replace(/[$}\\]/g, "\\$&");
}

/**
 * The directive a quick fix inserts, or null when the finding is already
 * suppressed or the scanner would not apply the directive, for example in
 * JSON, YAML, and other files it reads no directives from.
 */
export function suppressionEdit(
  request: SuppressionRequest,
  text: string,
): SuppressionEdit | null {
  if (DIRECTIVE_RULES.has(request.rule)) return null;
  const findingLine = request.fileLevel ? undefined : request.line;
  const { filePath, rule } = request;
  if (scannerSuppresses(filePath, text, rule, findingLine)) return null;

  const lines = text.split(/\r?\n/);
  const insertion = insertionFor(request, lines);
  if (!insertion) return null;

  // Offer only directives the scanner applies once a reason is typed.
  const edited = [...lines];
  edited.splice(
    insertion.line,
    0,
    directiveLine(request, insertion.indent, PROBE_REASON),
  );
  const movedLine =
    findingLine === undefined || findingLine < insertion.line
      ? findingLine
      : findingLine + 1;
  if (!scannerSuppresses(filePath, edited.join("\n"), rule, movedLine)) {
    return null;
  }

  // An empty tab stop: a reason left blank is not applied by the scanner,
  // whereas a placeholder word left in place would be.
  const snippet = directiveLine(
    { ...request, rule: escapeSnippet(rule) },
    insertion.indent,
    "$1",
  );
  return {
    scope: request.scope,
    rule,
    line: insertion.line,
    snippet: `${snippet}\n`,
  };
}

/**
 * Quick fixes for a finding: a mechanical remediation where one exists,
 * suppressions the scanner applies, then docs.
 */
export function quickFixes(
  finding: EditorDiagnostic,
  text: string,
): QuickFix[] {
  const suppressions = SCOPES.flatMap((scope): QuickFix[] => {
    const request: SuppressionRequest = {
      scope,
      filePath: finding.filePath,
      rule: finding.rule,
      line: finding.line,
      fileLevel: finding.fileLevel === true,
    };
    if (!suppressionEdit(request, text)) return [];
    const title = `Suppress ${finding.rule} ${SCOPE_LABELS[scope]}`;
    return [{ kind: "suppress", title, request }];
  });
  const remedy = remediation(finding, text);
  return [
    ...(remedy ? [remedy] : []),
    ...suppressions,
    {
      kind: "explain",
      title: `Explain ${finding.rule}`,
      url: ruleDocumentationUrl(finding.rule),
    },
  ];
}

function suppresses(edit: SuppressionEdit, finding: EditorDiagnostic): boolean {
  if (finding.rule !== edit.rule) return false;
  return (
    edit.scope === "file" || (!finding.fileLevel && finding.line === edit.line)
  );
}

/**
 * A file's findings once a directive is inserted: suppressed findings are
 * gone and located findings at or below the directive move down one line.
 * The next scan confirms the result.
 */
export function afterSuppression(
  findings: readonly EditorDiagnostic[],
  edit: SuppressionEdit,
): EditorDiagnostic[] {
  return findings
    .filter((finding) => !suppresses(edit, finding))
    .map((finding) =>
      !finding.fileLevel && finding.line >= edit.line
        ? { ...finding, line: finding.line + 1 }
        : finding,
    );
}

/** Validates suppression command arguments, which any extension can pass. */
export function isSuppressionRequest(
  value: unknown,
): value is SuppressionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof SuppressionRequest, unknown>>;
  return (
    (candidate.scope === "line" || candidate.scope === "file") &&
    typeof candidate.filePath === "string" &&
    typeof candidate.rule === "string" &&
    typeof candidate.line === "number" &&
    Number.isInteger(candidate.line) &&
    candidate.line >= 0 &&
    typeof candidate.fileLevel === "boolean"
  );
}
