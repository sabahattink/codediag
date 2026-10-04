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
- `scoring.version` configuration. With version 2, analyzer summaries that
  counted passed checks report finding counts instead.
- Inline suppressions: `codediag-ignore-next-line` and `codediag-ignore-file`
  comments with a required reason. Directives without a reason are not applied
  (`suppression-missing-reason`) and stale ones are reported
  (`unused-suppression`).
- `rules` configuration to turn rules off or change their severity.
- Offline scans: `--no-audit` or `audit: false` skips the package manager audit
  and reports `audit-skipped` instead.
- Audit results are cached per lock file and package.json within a process,
  and `scan()` accepts `audit: "cached"` to reuse them without running the
  package manager. VS Code scans triggered by saving use it, so scores no
  longer change between command-triggered and save-triggered scans.
- Baselines: `--baseline <report.json>` and `--update-baseline <path>`, plus a
  `baseline` Action input. Baseline findings are marked `baseline: true` and do
  not affect scores, thresholds, or annotations.
- SARIF `suppressions` and `baselineState` for suppressed and baseline
  findings.
- `dto-not-validated`: reported once when DTO classes are used but no global,
  `APP_PIPE`, controller, method, or parameter `ValidationPipe` validates them.
- `codediag rules` lists every rule (`--json` for metadata) and
  `codediag explain <rule>` describes one, with suppression and configuration
  snippets and suggestions for mistyped IDs. Terminal findings show their rule
  ID and `file:line`.
- Benchmark fixtures: realistic NestJS, Express, and Next.js applications that
  must score at least 85 with no critical findings, and defect applications
  that must keep producing specific findings.
- CodeDiag scans itself with a committed `.codediag.yml` (threshold 85).
- Fingerprints include the message for findings on a source line, so short
  lines such as `@Post()` keep distinct identities, and mask numbers in
  project-level messages (except vulnerability totals), so a moving test ratio
  stays in the baseline.
- Suppressed or baselined root causes no longer excuse their consequences, and
  a severity configured for an analyzer-failing rule (such as
  `no-test-files: info`) replaces its zero score.
- An optional `confidence` on findings (`high`, `medium`, `low`), also emitted
  as a SARIF result property.
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

- `node_modules`, `dist`, `coverage`, `.next`, and `.turbo` directories plus
  `*.min.js` and `*.map` files are now ignored at any depth,
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
- `--ci` keeps an explicitly chosen `--format` (for example `--ci --format
  sarif`) and only defaults to JSON when no format is given.
- `codediag init [path]` writes `.codediag.yml` into the given project
  directory, and the template documents `scoring`, `rules`, and
  `maxFileSizeKb`.
- Markdown reports moved to `src/reporters/markdown.ts`, are dated from the
  scan timestamp instead of the local clock, escape table cells, and list
  active finding counts.
- Node.js 20.19 or newer is required; CI tests Node 20, 22, and 24, and the
  GitHub Action runs on the `node24` runtime.
- Express routes are found on routers resolved from `express()`,
  `express.Router()`, `Router()`, and `Express`/`Router`-typed parameters
  instead of only on receivers named `app`, `api`, or `router`, including
  `router.route(path).get(...)` chains. Middleware registered with
  `router.use()` before a route, and middleware on `app.use(path, mw, router)`
  mounts across ES module and CommonJS imports, now counts as protection;
  messages show the mounted path. Receivers matched only by name produce
  findings with `confidence: "low"`, and names declared as anything else, such
  as an HTTP client called `api`, are no longer treated as routers. Untyped
  `app` parameters and factory-created apps fall back to low-confidence
  routes, and one-argument calls such as `app.get("port")` are not routes.
- NestJS endpoints are guarded by `app.useGlobalGuards()`, `APP_GUARD`
  providers, and custom decorators built on `UseGuards` (such as
  `applyDecorators`), and routes marked with `@Public()`, `@SkipAuth()`, or any
  decorator that sets public metadata are treated as intentionally open.
  `missing-dto` now requires a class body type: `any`, `Record<...>`,
  `Partial<...>`, inline types, and interfaces are reported, while endpoints
  without `@Body()`, single-field `@Body("name")` extractions, and primitive
  `string`/`number`/`boolean` bodies are not. `@Controller({ path })` and path
  arrays resolve to real routes.
- Shell and SQL sinks follow variables back through declarations,
  destructuring, and reassignments (up to three hops) to decide whether a value
  comes from request data, including Next.js `request.json()` and
  `searchParams`. Such findings are `critical`. Dynamic SQL built from request
  data is now reported for any client variable name, not only `db`, `pool`,
  `knex`, and similar names.
- Coverage thresholds are recognized from real configuration: Jest
  `coverageThreshold`, Vitest `coverage.thresholds` (or 0.x metric keys) in
  `vitest.config.*` or `vite.config.*`, node:test `--test-coverage-*` flags,
  and c8/nyc options. Mentioning "coverage" in a comment or enabling coverage
  without thresholds no longer counts.
- `hardcoded-secret` ignores values built with `${...}` interpolation and
  reports the first literal credential in a file instead.
- Project ownership and links now use the canonical Sabahattin Kalkan identity.
- CLI version is read from `package.json`.
- Threshold failures now return exit code 1 in every output mode.
- Plain scans remain informational unless a config, `--threshold`, or `--ci`
  enables a quality gate.
- Dependency auditing preserves vulnerability reports when `npm audit` exits
  non-zero.
- Security and structure checks apply framework-specific expectations only
  when the matching framework is detected.

### Security

- `npm audit fix` updated vulnerable transitive development dependencies.
  Production dependencies report no known vulnerabilities. Six high-severity
  advisories remain in `braces`, reached only through the development tool
  `@vscode/vsce` (via `secretlint` and `globby`), for which no patched
  `braces` release exists yet.

### Removed

- Tracked local Claude settings.
