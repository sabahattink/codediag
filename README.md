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

Scans for hardcoded secrets (API keys, Stripe keys, AWS credentials, GitHub tokens), validates `.gitignore`, checks helmet middleware, CORS configuration, rate limiting, and password hashing.

### Dependencies

Runs `npm audit`, checks lock file existence, flags deprecated packages, validates engine specs and essential npm scripts.

### Testing

Detects test files and frameworks (Jest, Vitest, Mocha, Ava), calculates test-to-source ratio, checks for e2e directories and coverage configuration.

### Structure

Validates README quality, linter/formatter config, TypeScript strict mode, NestJS module organization, and `.env.example` presence.

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
codediag scan . --format md        # Markdown (for PRs)
codediag scan . --format svg       # SVG score badge
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

The JSON output contract is published as
[`schema/scan-result.schema.json`](https://github.com/sabahattink/codediag/blob/main/schema/scan-result.schema.json).
See the
[JSON output documentation](https://github.com/sabahattink/codediag/blob/main/docs/json-output.md)
for compatibility guarantees and field definitions.

## CI/CD

```yaml
# GitHub Actions
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
- [x] npm audit results preserved when vulnerabilities produce a non-zero exit
- [x] Automated regression tests
- [ ] npm ownership migration and `0.2.0` release

### 0.3 - Framework depth

- [x] Next.js analyzer
- [x] Express analyzer
- [x] Framework-specific fixtures and integration tests

### 0.4 - CI distribution

- [x] SVG badge generator
- [ ] Reusable GitHub Action
- [x] Machine-readable schema documentation

### Later

- [ ] Web dashboard
- [ ] VS Code extension
- [ ] AI-powered fix proposals with explicit review

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
