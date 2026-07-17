<p align="center">
  <img src="assets/logo.svg" alt="codediag" width="80" />
</p>

<h1 align="center">codediag</h1>

<p align="center">
  <strong>Diagnose your code before you ship.</strong><br>
  <sub>One command. Five analyzers. One score.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codediag"><img src="https://img.shields.io/npm/v/codediag?color=cb3837&label=npm" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/codediag"><img src="https://img.shields.io/npm/dm/codediag?color=007ec6" alt="downloads" /></a>
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
npx codediag scan .
```

That's it. Configuration is optional. No account or server is required.

Or install globally:

```bash
npm install -g codediag
```

## What it checks

codediag auto-detects your stack and runs 5 analyzers:

### API Health `NestJS · Express · Next.js`

Uses AST analysis (ts-morph, not regex) to inspect NestJS decorators and
Express `app` or `router` routes. NestJS checks cover auth guards, typed DTOs,
Swagger docs, and return types. Express checks cover recognizable auth and
validation middleware, centralized error handling, and health endpoints.
Next.js checks App Router and Pages Router API handlers without penalizing
frontend-only projects.

### Security

Scans source files for hardcoded API keys and credentials, validates that
`.gitignore` protects `.env`, and verifies runtime use of Helmet and rate
limiting in supported web servers. It also reports open CORS configuration,
weak password hashes, direct password comparisons, and password persistence
without recognizable hashing. AST-based runtime checks detect `eval` and the
`Function` constructor, dynamic shell and SQL execution, and disabled TLS
certificate verification while excluding test fixtures. See
[Security analysis](docs/security-analysis.md) for rule behavior and scope.

### Dependencies

Runs the matching npm, pnpm, Yarn Classic, or modern Yarn audit command,
checks lock file existence, flags deprecated packages, and validates engine
specs and essential package scripts. Monorepo lock files are detected up to
three parent directories.

### Testing

Detects test files and frameworks (Jest, Vitest, Mocha, Ava), calculates the test-to-source ratio, and checks for e2e directories. When Jest, Vitest, or Istanbul produces `coverage/coverage-summary.json`, CodeDiag measures line and statement coverage against an 80% baseline and function and branch coverage against a 70% baseline. Without a report, it falls back to checking coverage configuration.

### Structure

Validates useful README content, workspace or package-level lint/format config,
resolved TypeScript strict mode, NestJS feature modules, and environment
templates such as `.env.example` or `.env.sample`.

## Scoring

Each analyzer scores 0-100. Weighted average determines the grade:

```
API Health: 25%  ·  Security: 30%  ·  Dependencies: 20%  ·  Testing: 15%  ·  Structure: 10%
```

| A+ | A | B+ | B | C | D | F |
|:--:|:-:|:--:|:-:|:-:|:-:|:-:|
| 95+ | 90+ | 85+ | 80+ | 70+ | 60+ | <60 |

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
codediag scan . --quiet            # Score only
codediag scan . --verbose          # All issues
codediag init                      # Create .codediag.yml
```

Generate a repository badge:

```bash
codediag scan . --format svg > codediag.svg
```

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
prompts directly in the editor. Successful GitHub Actions runs publish an
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
mapping and GitHub Code Scanning workflow.

## CI/CD

```yaml
# GitHub Actions (no npm install required)
- uses: sabahattink/codediag@main
  id: codediag
  with:
    threshold: 80
```

The Action adds score annotations and a job summary, writes JSON and SARIF
reports, and fails when the score is below the requested threshold. Its
`score`, `grade`, `report`, and `sarif` outputs can be used by later steps. See
the [GitHub Action guide](docs/github-action.md) for all inputs, outputs, and a
complete workflow.

```yaml
# npm-based GitHub Actions step
- run: npx codediag scan . --ci --threshold 80
```

```yaml
# GitLab CI
codediag:
  script: npx codediag scan . --ci --threshold 80
```

```bash
# Pre-push hook (husky)
npx codediag scan . --quiet --threshold 70
```

## Config

Optional. Create `.codediag.yml` or run `codediag init`. Command-line
`--threshold` takes precedence over the configured threshold. A configured
threshold is enforced whenever that project is scanned. Without a config file,
plain scans are informational; `--ci` uses the default threshold of 70.

```yaml
threshold: 70
ignore: [node_modules, dist, .git, coverage]
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

## Supported stacks

| Stack | API Health | Security | Deps | Testing | Structure |
|-------|:---------:|:--------:|:----:|:-------:|:---------:|
| NestJS | ✅ | ✅ | ✅ | ✅ | ✅ |
| Next.js | ✅ | ✅ | ✅ | ✅ | ✅ |
| Express | ✅ | ✅ | ✅ | ✅ | ✅ |
| Node.js | — | ✅ | ✅ | ✅ | ✅ |

## How it compares

| | codediag | SonarQube | Snyk | ESLint |
|---|:---:|:---:|:---:|:---:|
| Zero config | ✅ | ❌ | ❌ | ❌ |
| NestJS-aware | ✅ | ❌ | ❌ | ❌ |
| Security scan | ✅ | ✅ | ✅ | ❌ |
| Dep audit | ✅ | ❌ | ✅ | ❌ |
| Test check | ✅ | ✅ | ❌ | ❌ |
| Unified score | ✅ | ✅ | ❌ | ❌ |
| Offline | ✅ | ❌ | ❌ | ✅ |
| Free | ✅ | Partial | Partial | ✅ |

## Roadmap

CodeDiag is under active development. Existing analyzers are useful baseline
checks, not a claim of complete framework or security coverage.

### 0.2 - Reliable foundation

- [x] NestJS API, security, dependency, testing, and structure analyzers
- [x] Validated `.codediag.yml` configuration
- [x] Deterministic threshold exit behavior
- [x] npm, pnpm, and Yarn audit results preserved on vulnerability exit codes
- [x] Automated regression tests
- [ ] npm ownership migration and `0.2.0` release

### 0.3 - Framework depth

- [x] Next.js analyzer
- [x] Express analyzer
- [x] Framework-specific fixtures and integration tests

### 0.4 - CI distribution

- [x] SVG badge generator
- [x] Reusable GitHub Action
- [x] Machine-readable schema documentation
- [x] SARIF 2.1.0 and GitHub Code Scanning output

### Later

- [x] Portable HTML dashboard report
- [x] VS Code extension with Problems, reports, and review artifacts
- [x] Review-first fix plans and AI prompt export

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
