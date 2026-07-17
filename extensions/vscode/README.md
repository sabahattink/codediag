# CodeDiag for VS Code

Run CodeDiag project health checks without leaving VS Code. The extension uses
the same analyzer engine as the CodeDiag CLI.

## Commands

- **CodeDiag: Scan Workspace** publishes file findings to the Problems panel.
- **CodeDiag: Scan and Show HTML Report** opens the complete project report.
- **CodeDiag: Scan and Open Fix Plan** creates a review-required checklist.
- **CodeDiag: Scan and Create AI Review Prompt** creates a local, review-only
  handoff for a coding agent.
- **CodeDiag: Clear Diagnostics** removes current CodeDiag findings.

Click the CodeDiag status bar item to scan the active workspace. In a
multi-root workspace, CodeDiag scans the folder containing the active editor or
asks you to choose a folder.

## Settings

`codediag.scanOnSave` is disabled by default. When enabled, a scan starts 750 ms
after a file is saved. A scan may run the detected package manager's audit
command and therefore may access the network.

CodeDiag does not run in untrusted or virtual workspaces. Fix plans and AI
prompts never modify project files or upload source contents.

Project documentation: <https://sabahattink.github.io/codediag/>
