import { isAbsolute, relative, resolve } from "node:path";
import type { DiagnosticIssue, ScanResult } from "../../../src/types.js";

export interface EditorDiagnostic {
  analyzer: string;
  severity: DiagnosticIssue["severity"];
  rule: string;
  message: string;
  filePath: string;
  line: number;
  fix?: string;
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
    for (const issue of analyzer.issues) {
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
    for (const issue of analyzer.issues) counts[issue.severity] += 1;
  }
  return counts;
}
