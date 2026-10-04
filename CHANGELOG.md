# Changelog

All notable changes to CodeDiag are documented in this file.

## [Unreleased]

### Added

- A shared scan context: files are discovered once, read once, and parsed by a
  single ts-morph project for all analyzers.
- `.gitignore` support for source discovery, including nested files and parent
  directories up to the Git root.
- `maxFileSizeKb` configuration (default 512) and an optional `skipped` summary
  in JSON output for oversized, minified, or unreadable code files.
- A rule registry (`src/rules/registry.ts`) with titles, descriptions, default
  severities, CWE and OWASP mappings for all 62 rules, and generated rule
  documentation in `docs/rules.md`.
- SARIF rules now use registry titles and descriptions and include `helpUri`,
  `help`, CWE tags, and OWASP mappings.
- An optional line-number-independent `fingerprint` on each JSON issue.
- Scoring version 2: analyzers start at 100 and lose severity-weighted points
  per finding with diminishing returns per rule. Consequences of a reported
  root cause are downgraded to `info` with `causedBy` and cost nothing. Each
  analyzer reports a `scoreBreakdown`, shown in JSON, HTML, Markdown, and
  `--verbose` terminal output, and results include `scoringVersion`.
- `scoring.version` configuration.
- Inline suppressions: `codediag-ignore-next-line` and `codediag-ignore-file`
  comments with a required reason. Directives without a reason are not applied
  (`suppression-missing-reason`) and stale ones are reported
  (`unused-suppression`).
- `rules` configuration to turn rules off or change their severity.
- Baselines: `--baseline <report.json>` and `--update-baseline <path>`, plus a
  `baseline` Action input. Baseline findings are marked `baseline: true` and do
  not affect scores, thresholds, or annotations.
- SARIF `suppressions` and `baselineState` for suppressed and baseline
  findings.
- AST-based security sink detection for runtime code execution, dynamic shell
  commands, dynamic SQL queries, and disabled TLS certificate verification.
- SARIF 2.1.0 output through `--format sarif`, including stable rule IDs,
  source locations, severity mapping, and deterministic finding fingerprints.
- JSON and SARIF report outputs from the reusable GitHub Action for optional
  GitHub Code Scanning uploads.
- Express API health analysis for route authentication, request validation,
  centralized error handling, and runtime health endpoints.
- Express JavaScript and TypeScript integration coverage.
- Next.js App Router and Pages Router API analysis with frontend-only projects
  treated as not applicable.
- Framework-specific Express and Next.js integration fixtures.
- Dependency-free SVG score badge output through `--format svg`.
- A packaged JSON Schema and compatibility documentation for machine-readable
  scan results.
- Validated `.codediag.yml` loading with analyzer selection and ignore patterns.
- Regression tests for configuration, threshold handling, package version, and
  npm audit parsing.
- A single `npm run check` command for local and CI validation.
- Enforced Biome linting and formatting plus EditorConfig defaults.
- Contribution and security policies, structured issue forms, a pull request
  template, and automated dependency update configuration.
- A dependency-bundled reusable GitHub Action with quality gates, annotations,
  JSON reports, outputs, and job summaries.
- A GitHub-hosted smoke test that executes the checked-in Action bundle on
  every pull request and main-branch update.

### Changed

- `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, and `.turbo`
  directories plus `*.min.js` and `*.map` files are now ignored at any depth,
  not only at the project root. Monorepo scans no longer report findings from
  nested dependencies or build output.
- Replaced the `glob` runtime dependency with `minimatch` and `ignore`.
- SARIF results use a `codediagFinding/v2` partial fingerprint that no longer
  includes the line number, so alerts no longer reopen when code moves. The
  `codediagFinding/v1` key is removed; existing Code Scanning alerts are
  matched anew once after upgrading.
- Scores now use scoring version 2 by default, which changes most project
  scores. A single configuration gap such as a missing `.gitignore` no longer
  costs as much as dozens of injection findings, one root cause is penalized
  once, and NestJS GET endpoints without guards no longer lower the score
  without a finding. Set
  `scoring: { version: 1 }` to keep the previous scores; version 1 will be
  removed in the next minor release.
- Dependency audits are skipped when no lock file exists; the `no-lock-file`
  finding now says that dependencies cannot be audited instead of a separate
  misleading `audit-unavailable` warning.
- Scan progress lines report finding counts instead of preliminary scores.
- Project ownership and links now use the canonical Sabahattin Kalkan identity.
- CLI version is read from `package.json`.
- Threshold failures now return exit code 1 in every output mode.
- Plain scans remain informational unless a config, `--threshold`, or `--ci`
  enables a quality gate.
- Dependency auditing preserves vulnerability reports when `npm audit` exits
  non-zero.
- Security and structure checks apply framework-specific expectations only
  when the matching framework is detected.

### Removed

- Tracked local Claude settings.
