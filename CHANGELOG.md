# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- API Health for **Express**: route discovery (`app`/`router` methods, `router.route()`, routers mounted across ES modules and CommonJS), auth middleware, body validation, and unhandled async handlers on Express 4.
- API Health for **Next.js**: App Router `route.ts` handlers and `pages/api` handlers, with auth from session checks, auth wrappers or `middleware.ts`/`proxy.ts` matchers, and body validation.
- Express and Next.js projects without discovered routes skip API Health instead of being scored on it.
- `.codediag.yml` / `.codediag.yaml` is now read from the scanned directory: `threshold`, `ignore` (applied by every analyzer that walks files) and `analyzers` toggles. Invalid YAML, unknown keys and wrong types are reported with every problem at once.
- Exit code 2 for invalid flags or config and for failed scans (1 still means "below threshold").
- Markdown report lists issues with `file:line`; issues carry line numbers in all formats.
- Test suite (vitest) with NestJS, Express, Next.js and plain Node fixtures; CI runs it on Node 20 and 22.

### Changed

- **`--threshold` (or the config `threshold`, default 70) now sets the exit code in every mode**, not only with `--ci`. `codediag scan .` exits 1 when the score is below 70.
- Threshold precedence: `--threshold` > `.codediag.yml` > 70. `--threshold` and `--format` values are validated.
- JSON/markdown output and `--ci` write only the report to stdout. The spinner is shown only for interactive terminal output.
- Helmet and CORS checks run only for NestJS/Express; rate limiting and password hashing only for NestJS/Express/Next.js. Plain Node projects are no longer penalized for them.
- **Node 20+ is now required** (`engines.node >=20`). `glob@11`, a runtime dependency, already needed it; CI no longer runs Node 18.
- Dependency refresh via `npm audit fix` (brace-expansion DoS advisory GHSA-6j4f-fj2g-mc7p).
- NestJS module organization is only checked for NestJS projects; JavaScript projects are no longer penalized for having no `tsconfig.json`.
- NestJS: global guards (`APP_GUARD`, `useGlobalGuards`), `@Public()`-style decorators and public-by-design routes (login, register, auth, webhooks, health) are not reported as missing guards; `@Body() body: any` no longer counts as a DTO.

### Fixed

- `--version` reported 0.1.0; the version is now injected from `package.json` at build time.
- `npm audit` findings were never reported: npm exits non-zero when vulnerabilities exist, which was treated as "audit unavailable".
- The secret scan stopped after 100 files.
- `tsconfig.json` files with comments or trailing commas were reported as unparsable, and `strict` inherited through `extends` was missed.
- Helmet/CORS were only detected in `main.ts`; Express apps (`app.js`, `server.ts`, ...) were always flagged.
- `@Controller({ path: "x" })` produced garbled route paths.
- NestJS `*.e2e-spec.ts` files and jest config in `package.json` were not detected.

## [0.1.1]

### Fixed

- Monorepo support (lock file and `.gitignore` lookup in parent directories) and Windows path handling.

## [0.1.0]

### Added

- Initial release: API Health (NestJS), Security, Dependencies, Testing and Structure analyzers; terminal, JSON and markdown output; `codediag init`.
