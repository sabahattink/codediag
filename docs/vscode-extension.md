# VS Code extension

The CodeDiag extension runs the same local analyzer engine as the CLI and
publishes located findings to the VS Code Problems panel.

## Install a CI build

Until the extension is published to the Visual Studio Marketplace, download
the `codediag-vscode` artifact from a successful GitHub Actions run. Extract
the artifact and install the `.vsix` file with **Extensions: Install from
VSIX...** in the VS Code command palette.

The release package can also be built locally:

```bash
npm ci
npm run extension:package
```

The resulting file is written to `artifacts/`.

## Commands

- **CodeDiag: Scan Workspace** runs the analyzers and refreshes Problems.
- **CodeDiag: Scan and Show HTML Report** opens the interactive report.
- **CodeDiag: Scan and Open Fix Plan** opens a review-required checklist.
- **CodeDiag: Scan and Create AI Review Prompt** opens a local diagnostic
  handoff that prohibits edits until explicit approval.
- **CodeDiag: Clear Diagnostics** removes CodeDiag findings from Problems.

The status bar item runs a workspace scan. Multi-root workspaces use the
folder containing the active editor, or show a folder picker when no active
editor identifies one.

## Scan on save

`codediag.scanOnSave` is off by default. Enabling it starts a debounced scan
after saves. Dependency analysis may run the detected package manager's audit
command and can therefore access the network.

## Trust and data boundaries

- The extension is disabled in untrusted and virtual workspaces.
- Diagnostics resolving outside the selected workspace are not published.
- Analyzer output stays local unless the user deliberately shares a generated
  report or prompt.
- Fix plans and AI prompts never apply changes automatically.
