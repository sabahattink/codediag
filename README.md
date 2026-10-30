<p align="center">
  <img src="assets/logo.svg" alt="codediag" width="80" />
</p>

<h1 align="center">codediag</h1>

<p align="center">
  <strong>Diagnose your code before you ship.</strong><br>
  <sub>One command. Five analyzers. One score.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sabahattink/codediag"><img src="https://img.shields.io/npm/v/%40sabahattink/codediag?color=cb3837&label=npm" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@sabahattink/codediag"><img src="https://img.shields.io/npm/dm/%40sabahattink/codediag?color=007ec6" alt="downloads" /></a>
  <a href="https://github.com/sabahattink/codediag/actions"><img src="https://img.shields.io/github/actions/workflow/status/sabahattink/codediag/ci.yml?branch=main&label=CI" alt="CI" /></a>
  <a href="https://github.com/sabahattink/codediag/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sabahattink/codediag?color=2ea44f" alt="license" /></a>
</p>

<br>

<p align="center">
  <img src="assets/demo.svg" alt="codediag demo" width="680" />
</p>

<br>

## Install

```bash
npx @sabahattink/codediag scan .
```

That's it. Configuration is optional, no account or server is required, and
`--no-audit` keeps the scan fully offline.

Or install globally — this also puts the `codediag` command on your `PATH`,
which every other example below assumes:

```bash
npm install -g @sabahattink/codediag
```

> **Package name note:** published as `@sabahattink/codediag` while ownership
> of the legacy `codediag` name on npm is transferred. The CLI binary is still
> `codediag` after install. A migration announcement will follow if/when the
> unscoped name becomes available again.

## What it checks

codediag auto-detects your stack and runs 5 analyzers. Every finding has a
stable rule ID ([rule reference](docs/rules.md)), a severity, a location when
one exists, and a suggested fix.

### API Health `NestJS · Express · Fastify · Hono · Next.js · tRPC`

AST analysis (ts-morph, not regex) of the routes your app actually exposes.

- **NestJS:** auth guards, including global guards (`useGlobalGuards`,
  `APP_GUARD`), custom `UseGuards`-based decorators, and `@Public()`-style
  opt-outs; DTO classes for request bodies (not `any`, `Record`, or
  interfaces) and whether a `ValidationPipe` enforces them; Swagger docs and
  return types.
- **Express:** routers resolved from `express()`, `Router()`, and typed
  parameters; auth and validation middleware on routes, earlier
  `router.use()` calls, and `app.use(path, mw, router)` mounts across files;
  centralized error handling and health endpoints.
- **Fastify:** routes from `fastify.get()` and `fastify.route()`, followed
  through `register()`-ed plugins, `fastify-plugin` encapsulation, and
  `@fastify/autoload` directories (directory prefixes, `autoPrefix`, and
  autohooks, as `fastify-cli` projects use them);
  `onRequest`/`preHandler` auth hooks on the route or its context, body
  schemas on mutating routes, `setErrorHandler`, and health endpoints.
- **Hono:** routes on `new Hono()` apps, `basePath()`, and sub-apps mounted
  with `app.route()` across files, replayed in registration order; auth
  middleware (`jwt()`, `bearerAuth()`, `basicAuth()`, or your own) on the
  route or an earlier matching `app.use()`; `zValidator` and other body
  validators; `onError`; and health endpoints.
- **Next.js:** App Router and Pages Router API handlers, without penalizing
  frontend-only projects.
- **tRPC:** procedures resolved from `initTRPC` through builder chains,
  exported builders such as `protectedProcedure`, and nested or merged
  routers across files (including `~/` path aliases); mutations without auth
  middleware (judged by what the middleware checks, not its name), `.input()`
  parsers that accept anything, and error formatters or `isDev: true` that
  expose stack traces. Auth in front of every procedure counts too: a
  `createContext` that rejects anonymous callers, auth middleware ahead of
  the Express mount, or a Next.js `middleware.ts` (`proxy.ts` in Next.js 16)
  whose matcher covers the tRPC route. The checks run inside whichever server
  hosts tRPC (T3/Next.js, Express, Fastify), and a standalone tRPC server is
  its own stack. An intentionally public mutation, such as sign-up, is
  accepted with a reasoned `codediag-ignore-next-line` directive.

### Security

Hardcoded credentials, `.env` protection in `.gitignore`, Helmet, rate
limiting, open CORS, weak password hashing, and direct password comparisons.
Runtime sinks (`eval`, `new Function`, shell commands, raw SQL, disabled TLS
verification) are found in the AST, and request data is traced through
variables, destructuring, reassignments, and up to two calls into your own
helper functions and services, so `const cmd = req.query.cmd; exec(cmd)` is
critical, and so is `run(req.query.cmd)` when `run` calls `exec` in another
file. Request data is also followed into fields a class stores it in, through
constructors, into `map`/`forEach` callbacks and `for...of` loops, and to
NestJS providers behind an interface or injection token. tRPC procedure
`input` is request data too, even after `.input(schema)` validates it. Request data that reaches a file path, an outgoing
request's host, a redirect, or an HTML response is reported as path
traversal, SSRF, an open redirect, or reflected XSS; request data compiled as
a template or used as an object path is template injection or prototype
pollution. JWT options that accept `none` or ignore expiration, and session
cookies without `httpOnly`/`secure`, are flagged too. Secrets are also looked
for in JSON, YAML, Dockerfiles, `.npmrc`, and `.env` files that Git tracks,
and no report ever contains the value. With `--secret-history` (or
`secretHistory` in `.codediag.yml`), the lines recent commits added are also
searched for credentials that were committed and later deleted, which every
clone still contains (`secret-in-git-history`); it is off by default because
results depend on clone depth. See
[Security analysis](docs/security-analysis.md).

### Dependencies

Runs the matching npm, pnpm, Yarn Classic, or Yarn Berry audit (skipped with
`--no-audit`; `audit: production` checks only the dependencies you ship),
names the affected packages and their advisories in each vulnerability
finding, checks the lock file and `packageManager` consistency, flags
deprecated packages, and validates engine specs and essential scripts.
Monorepo lock files are found up to three parent directories. A successful
audit is kept for an hour in `node_modules/.cache/codediag`, keyed by the lock
file and `package.json`, so repeated scans reuse it (the Dependencies summary
says when); delete that directory to force a fresh audit.

### Testing

Test files and frameworks (Jest, Vitest, Mocha, Ava, node:test), the
test-to-source ratio, integration test directories, and coverage. A
`coverage-summary.json` is measured against 80% lines/statements and 70%
functions/branches; otherwise CodeDiag checks for a real coverage threshold in
Jest, Vitest, node:test, c8, or nyc configuration.

### Structure

README content, lint and format config (also inherited from a workspace root),
resolved TypeScript strict mode, NestJS feature modules, and environment
templates such as `.env.example`.

## Scoring

Each analyzer scores 0-100. Weighted average determines the grade:

```
API Health: 25%  ·  Security: 30%  ·  Dependencies: 20%  ·  Testing: 15%  ·  Structure: 10%
```

| A+ | A | B+ | B | C | D | F |
|:--:|:-:|:--:|:-:|:-:|:-:|:-:|
| 95+ | 90+ | 85+ | 80+ | 70+ | 60+ | <60 |

Analyzer scores use scoring version 2 by default: every analyzer starts at
100 and each finding subtracts a severity weight (critical 25, warning 8,
info 2). Further findings of the same rule cost half the previous one, so a
single rule costs at most twice its weight. A finding whose root cause is also
reported (for example "no test directory" when there are no tests at all) is
downgraded to `info`, linked with `causedBy`, and costs nothing. Findings that
leave an analyzer with nothing to evaluate, such as a missing `package.json`,
set that analyzer to 0.

Every lost point is listed in `scoreBreakdown` in JSON output, in the HTML and
Markdown reports, and under each analyzer with `--verbose`. Set
`scoring: { version: 1 }` to keep the previous checks-passed scores for one
more release.

## CLI

```bash
codediag scan .                    # Full report
codediag scan . --format json      # JSON (for CI/CD)
codediag scan . --format sarif     # SARIF 2.1.0 (for code scanning)
codediag scan . --format md        # Markdown (for PRs)
codediag scan . --format svg       # SVG score badge
codediag scan . --format html > codediag-report.html  # Interactive dashboard
codediag scan . --format fixes > codediag-fixes.md     # Review checklist
codediag scan . --format prompt > codediag-prompt.txt  # Review-only AI handoff
codediag scan . --ci               # JSON output + exit code
codediag scan . --threshold 80     # Exit 1 below 80 in any output mode
codediag scan . --fail-on critical # Exit 1 on any active critical finding
codediag scan . --quiet            # Score only
codediag scan . --verbose          # All issues and the score breakdown
codediag scan . --no-audit         # Offline: skip the package manager audit
codediag scan . --update-baseline .codediag-baseline.json  # Record accepted findings
codediag scan . --ci --baseline .codediag-baseline.json    # Fail only on new findings
codediag scan . --compare previous.json   # Score change, new and fixed findings
codediag scan . --changed-since origin/main  # Only files this branch changes
codediag scan . --workspaces              # Every monorepo package, combined
codediag scan . --history .codediag/history  # Record scans, show the trend
codediag scan . --secret-history         # Also secrets removed but still in Git history
codediag rules                     # List every rule
codediag explain open-cors         # Explain a rule and how to suppress it
codediag init                      # Create .codediag.yml
```

Generate a repository badge:

```bash
codediag scan . --format svg > codediag.svg
```

### Trends and changed files

`--compare` takes any earlier JSON report and shows what changed: the score
and each analyzer's delta, findings that are new (marked `NEW` and
`isNew: true`), and findings that have been fixed since. It works in every
output format; the HTML report adds a change panel and a "New" filter, and
SARIF marks results with `baselineState`.

```bash
codediag scan . --format json > reports/main.json      # on main
codediag scan . --compare reports/main.json --verbose  # on your branch
```

`--changed-since <revision>` limits a scan to the files that differ from a Git
revision: commits since the merge base, staged and unstaged edits, and new
untracked files. Only findings in those files are reported and scored, so the
score describes the change rather than the whole project, and the report says
how many findings elsewhere were left out.

```bash
codediag scan . --changed-since origin/main --threshold 90
```

`--history <directory>` keeps a trend: each scan is saved in the directory
(`codediag-<timestamp>.json`), and the report shows the score over the last
50 recorded scans, as a sparkline in the terminal and Markdown and as a chart
with a table view in the HTML report. Commit the directory, or cache it in CI,
to keep the history.

```bash
codediag scan . --history .codediag/history
```

### Monorepos

`--workspaces` scans every package of an npm, pnpm, or Yarn workspace, a
Lerna repository, or an Nx workspace (Turborepo uses your package manager's
workspaces). Each package gets its own stack detection and score, using its
own `.codediag.yml` if it has one and otherwise the root configuration, with
root `ignore` paths rebased into the package. The combined report lists every
package and averages each analyzer over the packages it ran in; the total
uses the usual analyzer weights. Package audits run four at a time before
the packages are analyzed. Findings are located relative to the root,
and project-level findings point at the package's `package.json`, so
baselines, `--compare`, `--changed-since`, SARIF, and the GitHub Action
(`workspaces: true`) work across the whole repository.

```bash
codediag scan . --workspaces
codediag scan . --workspaces --format html > monorepo-report.html
codediag scan . --workspaces --package-threshold 70   # Gate every package too
```

A combined average can hide one weak package. `packageThreshold` (or
`--package-threshold`, or the Action's `package-threshold` input) gates every
package on its own score as well: a package below it fails the scan, is
named on stderr and in the job summary, and is marked in every report. A
package's own `.codediag.yml` can set a different `packageThreshold`.

Scanning a workspace root without `--workspaces` scans it as one project and
suggests the flag.

### Review-first fix proposals

CodeDiag can turn analyzer findings into a prioritized remediation checklist.
Every item remains unchecked and explicitly requires review; CodeDiag never
edits project files or applies a recommendation automatically.

```bash
codediag scan . --format fixes > codediag-fixes.md
```

For use with a coding agent, `--format prompt` creates a structured handoff
that treats diagnostics as untrusted data and instructs the agent to inspect
the referenced files before proposing a patch. The prompt contains diagnostic
metadata only, not source file contents or secrets, and prohibits edits until
the user gives explicit approval.

```bash
codediag scan . --format prompt > codediag-prompt.txt
```

See the [review-first fix proposal guide](docs/fix-proposals.md) for the output
contract and recommended workflow.

### VS Code extension

The VS Code extension runs the same analyzer engine, publishes located
findings to the Problems panel, and opens HTML reports, fix plans, or AI review
prompts directly in the editor. Quick fixes on each problem suppress the rule
on that line or in the file (you type the reason) or open its documentation. Successful GitHub Actions runs publish an
installable `.vsix` artifact until the extension is available in the Visual
Studio Marketplace.

```bash
npm run extension:package
```

See the [VS Code extension guide](docs/vscode-extension.md) for installation,
commands, workspace trust boundaries, and scan-on-save behavior.

The JSON output contract is published as
[`schema/scan-result.schema.json`](https://github.com/sabahattink/codediag/blob/main/schema/scan-result.schema.json).
See the
[JSON output documentation](https://github.com/sabahattink/codediag/blob/main/docs/json-output.md)
for compatibility guarantees and field definitions.

For code-scanning platforms, `--format sarif` emits SARIF 2.1.0 with stable
rule IDs, source locations, severity levels, and finding fingerprints:

```bash
codediag scan . --format sarif > codediag-report.sarif
```

See the [SARIF output documentation](docs/sarif-output.md) for the field
mapping and GitHub Code Scanning workflow. Every rule is described in the
[rule reference](docs/rules.md).

## CI/CD

```yaml
# GitHub Actions (no npm install required)
- uses: sabahattink/codediag@v0
  id: codediag
  with:
    threshold: 80
```

The Action adds score annotations and a job summary, writes JSON and SARIF
reports, and fails when the score is below the requested threshold. With
`comment: true` (and `pull-requests: write` permission) it also keeps one
pull request comment up to date with the score, its change since the last
push, and the findings in the files the pull request changes. Its
`score`, `grade`, `report`, and `sarif` outputs can be used by later steps. See
the [GitHub Action guide](docs/github-action.md) for all inputs, outputs, and a
complete workflow.

<details>
<summary>Example pull request comment</summary>

> ## ✅ CodeDiag: 88/100 (B+)
>
> ▲ +4 since the last run · threshold 80
>
> | Analyzer | Score | Findings |
> | --- | ---: | ---: |
> | API Health | 92/100 | 1 |
> | Security | 67/100 | 2 |
> | Dependencies | 100/100 | 0 |
> | Testing | 98/100 | 1 |
> | Structure | 100/100 | 0 |
>
> ### Findings in changed files (2)
>
> | | Rule | Location | Finding |
> | --- | --- | --- | --- |
> | 🔴 | [`reflected-xss`](docs/rules.md#reflected-xss) | `src/routes/search.ts:14` | Request data is written into an HTML response without escaping |
> | 🟡 | [`open-redirect`](docs/rules.md#open-redirect) | `src/routes/auth.ts:31` | A redirect target comes from request data |
>
> Not listed: 1 finding elsewhere in the project.

</details>

Adopting CodeDiag on an existing codebase? Commit a baseline so the gate only
fails on new findings:

```yaml
- uses: sabahattink/codediag@v0
  with:
    threshold: 80
    baseline: .codediag-baseline.json   # created with --update-baseline
```

```yaml
# npm-based GitHub Actions step
- run: npx @sabahattink/codediag scan . --ci --threshold 80
```

```yaml
# GitLab CI
codediag:
  script: npx @sabahattink/codediag scan . --ci --threshold 80
```

```bash
# Pre-push hook (husky)
npx @sabahattink/codediag scan . --quiet --threshold 70
```

## Config

Optional. Create `.codediag.yml` or run `codediag init`. Command-line
`--threshold` takes precedence over the configured threshold. A configured
threshold is enforced whenever that project is scanned. Without a config file,
plain scans are informational; `--ci` uses the default threshold of 70.

```yaml
threshold: 70
failOn: critical         # optional; any active critical finding fails the scan
packageThreshold: 60     # optional; each --workspaces package must reach it
ignore: [node_modules, dist, .git, coverage]
maxFileSizeKb: 512
scoring:
  version: 2
rules:
  missing-swagger: off   # or info, warning, critical
audit: true              # false skips the network audit; production skips devDependencies
secretHistory: false     # true searches the last 1000 commits for removed secrets, or give a number
analyzers:
  api: true
  security: true
  dependencies: true
  testing: true
  structure: true
```

Unknown options and invalid values fail the scan instead of being silently
ignored. Directory and glob entries under `ignore` are applied to analyzers
that inspect source files.

Individual findings can be suppressed in source with a required reason, and
existing findings can be accepted with a baseline so CI fails only on new
problems:

```ts
// codediag-ignore-next-line unsafe-dynamic-code -- plugin code is signed and sandboxed
```

See [suppressions, rule settings, and baselines](docs/suppressions-and-baselines.md).

Source discovery always skips `node_modules`, `dist`, `coverage`, `.next`, and
`.turbo` directories at any depth, `*.min.js` and `*.map` files, dot
directories, and everything matched by the project's `.gitignore` files
(including nested ones and those in parent directories up to the Git root).
Code files larger than `maxFileSizeKb` or that look like minified bundles are
skipped and reported in the JSON `skipped` summary.

## Supported stacks

| Stack | API Health | Security | Deps | Testing | Structure |
|-------|:---------:|:--------:|:----:|:-------:|:---------:|
| NestJS | ✅ | ✅ | ✅ | ✅ | ✅ |
| Next.js | ✅ | ✅ | ✅ | ✅ | ✅ |
| Express | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fastify | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hono | ✅ | ✅ | ✅ | ✅ | ✅ |
| tRPC | ✅ | ✅ | ✅ | ✅ | ✅ |
| Node.js | — | ✅ | ✅ | ✅ | ✅ |

## Where CodeDiag fits

CodeDiag is a fast, explainable health check for Node.js backends, not a
replacement for a linter or a full SAST platform. Use it alongside them:

- **ESLint or Biome** catch code-level mistakes as you type; CodeDiag checks
  project-level safeguards they do not see, such as whether a NestJS route is
  covered by a global guard or an Express router is mounted behind auth.
- **Semgrep, CodeQL, or SonarQube** run deep, language-wide rule sets;
  CodeDiag focuses on a small set of framework-aware rules with low noise and
  a score that explains every lost point.
- **npm audit, Snyk, or Dependabot** track vulnerable dependencies; CodeDiag
  runs your package manager's audit and folds it into the same report.

Everything runs locally from one command, with SARIF output when you want
results in GitHub Code Scanning.

## Roadmap

- **0.2:** analyzers for NestJS, Express, and Next.js; validated config; JSON
  schema, SARIF, HTML, SVG badge, fix plans, GitHub Action, and VS Code
  extension.
- **0.3 "Reliable Engine":** gitignore-aware discovery that skips nested
  dependencies and bundles (CodeDiag's own scan went from 15 s to 1.3 s), a
  rule registry, explainable scoring, suppressions, baselines, offline
  scans, and precision fixes for Express, NestJS, and security sinks. See the
  [changelog](CHANGELOG.md).
- **0.4 and 0.5:** path traversal, SSRF, open redirect, and reflected XSS
  rules; a pull request comment from the GitHub Action.
- **0.6 "Deep Scan":** Fastify analysis; JWT, cookie, template injection,
  prototype pollution, and shell spawn rules; secret scanning in
  configuration files and committed `.env` files; `--compare` and
  `--changed-since`; a redesigned HTML report; VS Code quick fixes.
- **0.7 "Across":** cross-file taint through helpers and services;
  `--workspaces` for monorepos (CLI, Action, and VS Code); Hono analysis;
  `--history` score trends; base-branch deltas in pull request comments;
  audit advisory details and `audit: production`.
- **0.8 "Depth":** tRPC procedures; taint through fields, constructors,
  callbacks, and injected providers; `@fastify/autoload` projects; secrets
  removed from the tree but kept in Git history; per-package thresholds and
  `--fail-on` gates; remediation quick fixes in VS Code.
- **0.9 "Perimeter":** tRPC auth in `createContext`, Express mounts, and
  Next.js middleware; audits cached for an hour and run concurrently across
  workspace packages; Dependabot updates that rebuild the Action bundle.
- **Next:** see [docs/roadmap.md](docs/roadmap.md) for planned framework
  support, editor improvements, and deeper taint tracking.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, testing
expectations, and pull request guidance.

```bash
git clone https://github.com/sabahattink/codediag.git
cd codediag
npm ci
npm run check
node dist/index.js scan /path/to/project
```

Use [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`

Security vulnerabilities should be reported privately according to
[SECURITY.md](SECURITY.md), not through a public issue.

## License

MIT - [Sabahattin Kalkan](https://sabahattinkalkan.com)

<br>

<p align="center">
  <sub>If codediag caught something before your users did, give it a ⭐</sub>
</p>
