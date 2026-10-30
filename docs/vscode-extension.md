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

## Quick fixes

Every CodeDiag problem offers code actions of kind Quick Fix:

| Action | Effect |
| --- | --- |
| Enable TLS certificate verification | `tls-verification-disabled`: rewrites `rejectUnauthorized: false` to `true`. |
| Verify the token's expiration time | `jwt-expiration-ignored`: rewrites `ignoreExpiration: true` to `false`. |
| Stop accepting the "none" algorithm | `jwt-none-algorithm`: removes `"none"` from a literal `algorithms` list that keeps another algorithm. |
| Suppress `<rule>` on this line | Inserts `// codediag-ignore-next-line <rule> -- ` above the finding with the same indentation. |
| Suppress `<rule>` in this file | Inserts `// codediag-ignore-file <rule> -- ` after the shebang and leading comments. |
| Explain `<rule>` | Opens the rule's section of the [rule reference](rules.md). |

The first three are remediations: the fix the rule asks for, offered as the
preferred quick fix only when the finding's line holds exactly the reported
setting once. A line edited since the scan, a list of only `"none"`, or a
computed list gets no remediation. The next scan confirms the fix.

Directives are inserted with the cursor right after `--`, so you type the
justification there. CodeDiag does not apply a directive without a reason
and reports it as `suppression-missing-reason`; see
[Suppressions, rule settings, and baselines](suppressions-and-baselines.md).

Suppression actions follow the scanner, not a copy of its rules: before
offering one, the extension runs CodeDiag's suppression pass on the open
document, with and without the new directive. As a result they are:

- offered only in files the scanner reads directives from (JavaScript and
  TypeScript), never in `package.json`, `.env`, YAML, or Dockerfiles;
- offered only for findings that no directive in the current text already
  suppresses;
- not offered for `suppression-missing-reason` and `unused-suppression`, which
  are fixed by correcting the directive;
- offered per line only for findings that have a line.

Applying a suppression removes the finding from the Problems panel and moves
the file's later findings down one line; the next scan confirms the result.
Suppressions are never marked as the preferred fix, so auto-fix commands do
not apply them. Each problem's rule ID also links to the rule reference.

## Scan on save

`codediag.scanOnSave` is off by default. Enabling it starts a debounced scan
after saves. Scans started by saving a file never run the package manager:
they reuse the dependency audit from the last command-triggered scan of the
same lock file, or an audit of it cached on disk within the hour, so scores
stay consistent, and report `audit-skipped` until one has run. Commands run from the Command Palette follow the project's
`audit` setting.

## Monorepos

`codediag.scanWorkspacePackages` is on by default. When the workspace folder
is a monorepo root (npm, pnpm, or Yarn workspaces, Lerna, or Nx), each package
is scanned with its own stack detection and configuration and the results are
combined, as `codediag scan --workspaces` does. Problems keep their real file
locations, and package-level findings appear on each package's
`package.json`. Turn the setting off to scan the root as one project.

## Trust and data boundaries

- The extension is disabled in untrusted and virtual workspaces.
- Diagnostics resolving outside the selected workspace are not published.
- Analyzer output stays local unless the user deliberately shares a generated
  report or prompt.
- Fix plans and AI prompts never apply changes automatically.
