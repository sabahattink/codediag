import { basename } from "node:path";
import * as vscode from "vscode";
import { loadConfig } from "../../../src/config.js";
import { scanWorkspace } from "../../../src/core/workspace-scan.js";
import { detectWorkspaces } from "../../../src/core/workspaces.js";
import {
  renderAiPrompt,
  renderFixPlan,
} from "../../../src/reporters/fix-plan.js";
import { renderHtml } from "../../../src/reporters/html.js";
import { scan } from "../../../src/scanner.js";
import type { ScanResult } from "../../../src/types.js";
import {
  afterSuppression,
  collectEditorDiagnostics,
  countSeverities,
  type EditorDiagnostic,
  isSuppressionRequest,
  type QuickFix,
  quickFixes,
  ruleDocumentationUrl,
  suppressionEdit,
} from "./core.js";

const COMMANDS = {
  scan: "codediag.scanWorkspace",
  report: "codediag.showReport",
  fixes: "codediag.showFixPlan",
  prompt: "codediag.createAiPrompt",
  clear: "codediag.clearDiagnostics",
  // Internal: run by the suppression quick fixes, so not contributed.
  suppress: "codediag.insertSuppression",
} as const;

interface LatestScan {
  root: string;
  result: ScanResult;
}

let latestScan: LatestScan | undefined;
let scanInFlight: Promise<LatestScan | undefined> | undefined;

function diagnosticSeverity(
  severity: "critical" | "warning" | "info",
): vscode.DiagnosticSeverity {
  switch (severity) {
    case "critical":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

async function selectWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage(
      "Open a project folder before running CodeDiag.",
    );
    return undefined;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) return activeFolder.uri.fsPath;
  }

  if (folders.length === 1) return folders[0]?.uri.fsPath;

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      root: folder.uri.fsPath,
    })),
    { placeHolder: "Select the workspace folder to scan" },
  );
  return selected?.root;
}

/**
 * A published finding. Code action contexts hand back these same objects, so
 * quick fixes read the finding instead of parsing the diagnostic.
 */
class CodeDiagDiagnostic extends vscode.Diagnostic {
  readonly finding: EditorDiagnostic;

  constructor(finding: EditorDiagnostic) {
    super(
      new vscode.Range(finding.line, 0, finding.line, 0),
      finding.fix
        ? `${finding.message}\nSuggested fix: ${finding.fix}`
        : finding.message,
      diagnosticSeverity(finding.severity),
    );
    this.finding = finding;
    this.source = `CodeDiag · ${finding.analyzer}`;
    this.code = {
      value: finding.rule,
      target: vscode.Uri.parse(ruleDocumentationUrl(finding.rule)),
    };
  }
}

function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  result: ScanResult,
  root: string,
  output: vscode.OutputChannel,
): void {
  collection.clear();
  const summary = collectEditorDiagnostics(result, root);
  const grouped = new Map<string, vscode.Diagnostic[]>();

  for (const item of summary.diagnostics) {
    const existing = grouped.get(item.filePath) ?? [];
    existing.push(new CodeDiagDiagnostic(item));
    grouped.set(item.filePath, existing);
  }

  for (const [filePath, items] of grouped) {
    collection.set(vscode.Uri.file(filePath), items);
  }

  if (summary.fileless > 0) {
    output.appendLine(
      `${summary.fileless} finding(s) have no file location; see the report or fix plan.`,
    );
  }
  if (summary.outsideWorkspace > 0) {
    output.appendLine(
      `${summary.outsideWorkspace} finding path(s) were ignored because they resolve outside the workspace.`,
    );
  }
}

async function runScan(
  collection: vscode.DiagnosticCollection,
  status: vscode.StatusBarItem,
  output: vscode.OutputChannel,
  preferredRoot?: string,
  trigger: "command" | "save" = "command",
): Promise<LatestScan | undefined> {
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    const root = preferredRoot ?? (await selectWorkspaceRoot());
    if (!root) return undefined;

    status.text = "$(sync~spin) CodeDiag scanning";
    status.tooltip = `Scanning ${root}`;
    output.appendLine(`[${new Date().toISOString()}] Scanning ${root}`);

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodeDiag: ${basename(root)}`,
        },
        async (progress) => {
          const options = {
            interactive: false,
            // Saves trigger frequent scans: reuse the last audit of the same
            // lock file instead of blocking on the network.
            ...(trigger === "save" ? { audit: "cached" as const } : {}),
            onProgress: (message: string) => progress.report({ message }),
          };
          // A monorepo root is scanned package by package; the combined
          // report locates findings relative to the root, as before.
          const workspaces = vscode.workspace
            .getConfiguration("codediag", vscode.Uri.file(root))
            .get<boolean>("scanWorkspacePackages", true)
            ? detectWorkspaces(root)
            : null;
          return workspaces
            ? scanWorkspace(root, loadConfig(root), workspaces, options)
            : scan(root, loadConfig(root), options);
        },
      );

      latestScan = { root, result };
      publishDiagnostics(collection, result, root, output);
      const counts = countSeverities(result);
      status.text = `$(shield) CodeDiag ${result.totalScore} ${result.grade}`;
      status.tooltip = `${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`;
      status.backgroundColor =
        counts.critical > 0
          ? new vscode.ThemeColor("statusBarItem.errorBackground")
          : undefined;
      output.appendLine(
        `Score ${result.totalScore}/100 (${result.grade}); ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`,
      );
      return latestScan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.text = "$(error) CodeDiag failed";
      status.tooltip = message;
      status.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      output.appendLine(`ERROR: ${message}`);
      output.show(true);
      void vscode.window.showErrorMessage(`CodeDiag scan failed: ${message}`);
      return undefined;
    } finally {
      scanInFlight = undefined;
    }
  })();

  return scanInFlight;
}

async function openGeneratedDocument(
  content: string,
  language: "markdown" | "plaintext",
): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

function codeAction(
  fix: QuickFix,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    fix.title,
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  // Suppressing is a deliberate decision, never the automatic fix.
  action.isPreferred = false;
  action.command =
    fix.kind === "suppress"
      ? {
          command: COMMANDS.suppress,
          title: fix.title,
          arguments: [fix.request],
        }
      : {
          command: "vscode.open",
          title: fix.title,
          arguments: [vscode.Uri.parse(fix.url)],
        };
  return action;
}

const quickFixProvider: vscode.CodeActionProvider = {
  provideCodeActions(document, _range, context) {
    const findings = context.diagnostics.filter(
      (diagnostic): diagnostic is CodeDiagDiagnostic =>
        diagnostic instanceof CodeDiagDiagnostic,
    );
    if (findings.length === 0) return [];
    const text = document.getText();
    return findings.flatMap((diagnostic) =>
      quickFixes(diagnostic.finding, text).map((fix) =>
        codeAction(fix, diagnostic),
      ),
    );
  },
};

function findingsIn(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): EditorDiagnostic[] {
  return (collection.get(uri) ?? []).flatMap((diagnostic) =>
    diagnostic instanceof CodeDiagDiagnostic ? [diagnostic.finding] : [],
  );
}

/**
 * Inserts the directive with the cursor after `--` for the reason, then updates
 * the file's findings until the next scan confirms the suppression.
 */
async function insertSuppression(
  collection: vscode.DiagnosticCollection,
  request: unknown,
): Promise<void> {
  if (!isSuppressionRequest(request)) {
    throw new Error(`${COMMANDS.suppress} expects a suppression request`);
  }
  const uri = vscode.Uri.file(request.filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = suppressionEdit(request, document.getText());
  if (!edit) {
    void vscode.window.showInformationMessage(
      `CodeDiag cannot suppress ${request.rule} here any more. Scan again to refresh the findings.`,
    );
    return;
  }

  const visible = vscode.window.visibleTextEditors.find(
    (editor) => editor.document === document,
  );
  const editor = await vscode.window.showTextDocument(
    document,
    visible?.viewColumn,
  );
  const inserted = await editor.insertSnippet(
    new vscode.SnippetString(edit.snippet),
    new vscode.Position(edit.line, 0),
  );
  if (!inserted) return;
  collection.set(
    uri,
    afterSuppression(findingsIn(collection, uri), edit).map(
      (finding) => new CodeDiagDiagnostic(finding),
    ),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("codediag");
  const output = vscode.window.createOutputChannel("CodeDiag");
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90,
  );
  status.name = "CodeDiag project health";
  status.text = "$(shield) CodeDiag";
  status.tooltip = "Scan the current workspace with CodeDiag";
  status.command = COMMANDS.scan;
  status.show();

  const scanCurrent = () => runScan(diagnostics, status, output);
  context.subscriptions.push(
    diagnostics,
    output,
    status,
    vscode.commands.registerCommand(COMMANDS.scan, scanCurrent),
    vscode.commands.registerCommand(COMMANDS.report, async () => {
      const current = await scanCurrent();
      if (!current) return;
      const panel = vscode.window.createWebviewPanel(
        "codediagReport",
        `CodeDiag · ${current.result.project}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [] },
      );
      panel.webview.html = renderHtml(current.result);
    }),
    vscode.commands.registerCommand(COMMANDS.fixes, async () => {
      const current = await scanCurrent();
      if (current)
        await openGeneratedDocument(renderFixPlan(current.result), "markdown");
    }),
    vscode.commands.registerCommand(COMMANDS.prompt, async () => {
      const current = await scanCurrent();
      if (current)
        await openGeneratedDocument(
          renderAiPrompt(current.result),
          "plaintext",
        );
    }),
    vscode.commands.registerCommand(COMMANDS.clear, () => {
      diagnostics.clear();
      latestScan = undefined;
      status.text = "$(shield) CodeDiag";
      status.tooltip = "Scan the current workspace with CodeDiag";
      status.backgroundColor = undefined;
    }),
    vscode.commands.registerCommand(COMMANDS.suppress, (request: unknown) =>
      insertSuppression(diagnostics, request),
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      quickFixProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  const saveTimers = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const settings = vscode.workspace.getConfiguration(
        "codediag",
        document.uri,
      );
      if (!settings.get<boolean>("scanOnSave", false)) return;
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return;

      const root = folder.uri.fsPath;
      const existing = saveTimers.get(root);
      if (existing) clearTimeout(existing);
      saveTimers.set(
        root,
        setTimeout(() => {
          saveTimers.delete(root);
          void runScan(diagnostics, status, output, root, "save");
        }, 750),
      );
    }),
    new vscode.Disposable(() => {
      for (const timer of saveTimers.values()) clearTimeout(timer);
      saveTimers.clear();
    }),
  );
}

export function deactivate(): void {
  latestScan = undefined;
  scanInFlight = undefined;
}
