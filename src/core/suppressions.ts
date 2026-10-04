import { fromRule, getRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import type { ScanContext } from "./scan-context.js";

const SOURCE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}";
const MARKER = "codediag-ignore";

/**
 * A directive must be the only content of its line, so text inside string
 * literals or after code is never treated as a suppression.
 */
const DIRECTIVE =
  /^\s*(?:\/\/|\/\*+)\s*codediag-ignore-(next-line|file)\b(.*?)(?:\*\/)?\s*$/;

interface Directive {
  file: string;
  /** 1-based line of the comment itself. */
  line: number;
  scope: "next-line" | "file";
  /** The line a next-line directive applies to. */
  target?: number;
  rules: string[];
  reason: string;
  used: boolean;
}

function parseDirectives(file: string, content: string): Directive[] {
  const lines = content.split(/\r?\n/);
  const directives: Directive[] = [];
  const pendingNextLine: Directive[] = [];

  lines.forEach((text, index) => {
    const match = DIRECTIVE.exec(text);
    if (!match) {
      // Stacked next-line directives all apply to the first code line.
      for (const directive of pendingNextLine.splice(0)) {
        directive.target = index + 1;
      }
      return;
    }

    const [ruleText, ...reasonParts] = match[2].split("--");
    const directive: Directive = {
      file,
      line: index + 1,
      scope: match[1] as Directive["scope"],
      rules: ruleText
        .split(/[\s,]+/)
        .map((rule) => rule.trim())
        .filter(Boolean),
      reason: reasonParts.join("--").trim(),
      used: false,
    };
    directives.push(directive);
    if (directive.scope === "next-line") pendingNextLine.push(directive);
  });

  return directives;
}

function matches(directive: Directive, issue: DiagnosticIssue): boolean {
  if (issue.file !== directive.file) return false;
  if (!directive.rules.includes(issue.rule)) return false;
  return directive.scope === "file" || issue.line === directive.target;
}

/** The analyzer a directive's own finding belongs to. */
function ownerFor(directive: Directive): string {
  for (const rule of directive.rules) {
    const definition = getRule(rule);
    if (definition) return definition.analyzer;
  }
  return "Structure";
}

function directiveIssue(directive: Directive): DiagnosticIssue | null {
  const label = `codediag-ignore-${directive.scope}`;
  if (directive.rules.length === 0 || !directive.reason) {
    return {
      ...fromRule("suppression-missing-reason"),
      message: `${label} needs rule IDs and a reason after "--"; it was not applied`,
      file: directive.file,
      line: directive.line,
      fix: `Write ${label} <rule-id> -- <why this finding is acceptable>`,
    };
  }
  if (directive.used) return null;

  const unknown = directive.rules.filter((rule) => !getRule(rule));
  return {
    ...fromRule("unused-suppression"),
    message:
      unknown.length > 0
        ? `${label} names unknown rule ${unknown.join(", ")}`
        : `${label} for ${directive.rules.join(", ")} matches no finding`,
    file: directive.file,
    line: directive.line,
    fix: "Remove the directive or correct its rule IDs",
  };
}

/**
 * Applies `codediag-ignore-next-line` and `codediag-ignore-file` comments.
 * Suppressed findings stay in the result with a `suppression` justification;
 * malformed or unused directives become `info` findings of their own.
 */
export function applySuppressions(
  results: AnalyzerResult[],
  context: ScanContext,
): AnalyzerResult[] {
  const directives = context.matchFiles(SOURCE_PATTERN).flatMap((file) => {
    const content = context.readText(file);
    return content?.includes(MARKER) ? parseDirectives(file, content) : [];
  });
  if (directives.length === 0) return results;

  const valid = directives.filter(
    (directive) => directive.rules.length > 0 && directive.reason,
  );
  const suppressed = results.map((result) => ({
    ...result,
    issues: result.issues.map((issue) => {
      const directive = valid.find((candidate) => matches(candidate, issue));
      if (!directive) return issue;
      directive.used = true;
      return {
        ...issue,
        suppression: {
          kind: "inSource" as const,
          justification: directive.reason,
        },
      };
    }),
  }));

  return suppressed.map((result) => ({
    ...result,
    issues: [
      ...result.issues,
      ...directives
        .filter((directive) => ownerFor(directive) === result.name)
        .flatMap((directive) => directiveIssue(directive) ?? []),
    ],
  }));
}
