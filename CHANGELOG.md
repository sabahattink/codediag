# Changelog

All notable changes to CodeDiag are documented in this file.

## [0.9.0] - 2026-10-30

The "Perimeter" release: tRPC apps that authenticate in front of their
procedures stop getting missing-auth warnings, dependency audits are cached
and run concurrently across monorepo packages, and Dependabot updates keep
the Action bundle in step.

### Added

- tRPC mutations are no longer reported as missing auth middleware when the
  whole router is authenticated before procedures run: a `createContext` (or
  a project function it calls) that throws `TRPCError` `UNAUTHORIZED` or
  `FORBIDDEN`, or throws when the session is missing; auth middleware ahead
  of the Express mount that serves the adapter; or a Next.js `middleware.ts`
  (`proxy.ts` in Next.js 16) that rejects anonymous requests
  (`next-auth/middleware`, Clerk's `auth.protect()` under a route matcher, or
  a redirect or 401/403 when the session is missing) and whose `matcher`
  covers the tRPC route. A `createContext` that only reads the session, as
  T3's does, and the common `/((?!api|...).*)` matcher that skips the API do
  not count. The API Health summary names where the perimeter was found.
- Successful dependency audits are kept for an hour in
  `node_modules/.cache/codediag`, keyed by the audit command and the exact
  lock file and `package.json` contents, and reused by later scans and
  editor saves. Entries are validated on read, failed audits are never kept,
  nothing is written without a `node_modules` directory, and the Dependencies
  summary says when a result was reused.
- Dependabot pull requests that change the Action bundle get it rebuilt: a
  read-only job builds it, and a job that runs no repository or dependency
  code commits the two bundle files and starts CI for the new commit.
  Dependabot groups minor and patch npm updates into one pull request.

### Changed

- `--workspaces` scans run every package's audit up front, four at a time,
  and the package scans reuse those outcomes, so audit waits overlap instead
  of adding up.
- VS Code extension 0.7.0: scans on save also reuse an audit cached on disk
  within the hour.

## [0.8.0] - 2026-10-30

The "Depth" release: tRPC procedures, request data followed through fields,
constructors, callbacks, and injected providers, `fastify-cli` projects as
`@fastify/autoload` loads them, secrets that Git history still holds, gates
that a good average cannot hide, and fixes you apply from the editor.

### Added

- tRPC API Health analysis: procedures from `initTRPC` instances are
  followed through `.use()`/`.input()` builder chains, exported and
  destructured builders (`publicProcedure`, `protectedProcedure`, T3's
  `createTRPCRouter`), nested, record, and merged routers, and imports across
  files, including tsconfig `paths` such as `~/`. New warnings:
  `missing-trpc-auth-middleware` (mutations whose middleware never rejects
  anonymous callers; a `protectedProcedure` is judged by its middleware, not
  its name), `unvalidated-trpc-input` (`z.any()`, `z.unknown()`,
  `z.custom()`, Valibot `any`/`unknown`, or `(v) => v as T` parsers), and
  `trpc-stack-trace-exposed` (`isDev: true`, or an `errorFormatter` that
  returns `error.stack` unconditionally). The checks join the API Health
  result of the server that runs tRPC (Next.js, Express, Fastify, Hono,
  NestJS); a server whose only endpoints are tRPC procedures, such as a T3
  App Router project, is no longer reported as having none, and a standalone
  tRPC server is detected as `trpc`.
- tRPC procedure input (`({ input })`, `opts.input`) is request data for the
  security sink rules, even after `.input(schema)` validation, and is
  followed into helpers and services two calls deep.
- Taint through object state: request data a class stores on `this` (in its
  constructor, a method, or a field initializer, including TypeScript
  parameter properties) reaches sinks that read the field in another member,
  and a `new` expression that passes request data to a constructor taints
  the fields set from that parameter, through imports and `require()`. A
  write earlier in the reading method's own code overrides writes elsewhere.
- Taint through callbacks: elements of request data flow into inline
  `forEach`, `map`, `filter`, `some`, `every`, `find`, `findIndex`,
  `findLast`, `findLastIndex`, `flatMap`, `reduce`, and `reduceRight`
  callbacks, `for...of` variables, and `then()` callbacks; a project function
  that invokes a callback written inline at its call site is followed for
  that call only.
- Methods reached through a project interface or abstract class, or through a
  NestJS `@Inject()` token, resolve to their one implementation via
  `implements`/`extends` clauses and `{ provide, useClass }` providers;
  ambiguous cases are not followed. Findings traced through fields,
  constructors, project callbacks, or injected providers keep their sink
  line, message, and fingerprint, get `confidence: "medium"`, and name where
  request data enters.
- `secret-in-git-history` (critical, opt-in): credentials that commits on
  the checked-out branch added and the current tree no longer has, which
  every clone still contains. Turn it on with `secretHistory: true` (the last
  1000 commits) or a commit count in `.codediag.yml`, `--secret-history
  [commits]`, or the Action's `secret-history` input (with `actions/checkout`
  `fetch-depth: 0`). Added lines are checked with the same detectors as the
  current tree; secrets are compared by digest in memory and never stored or
  printed, and fingerprints are based on the commit, not the secret. The
  Security summary says how much history was read and flags shallow clones,
  and `secret-history-incomplete` (info) notes a scan cut short by its 64 MiB
  or 60-second limit.
- Fastify projects that load plugins with `@fastify/autoload` (the layout
  `fastify-cli` generates) are analyzed as they run: autoloaded plugins share
  the context that registers autoload, directory names become route
  prefixes, `autoPrefix` and `prefixOverride` exports and `options.prefix`
  apply, an index file replaces the other files of its directory, and with
  `autoHooks` a directory's autohooks protect its routes (and its
  subdirectories' with `cascadeHooks`). Directories may be given with
  `__dirname`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`,
  or `new URL(..., import.meta.url)`. Such projects previously got
  unprefixed, low-confidence routes and missing-auth findings for routes
  their autohooks protect.
- `packageThreshold` in `.codediag.yml`, `--package-threshold`, and the
  Action's `package-threshold` input gate every package of a `--workspaces`
  scan on its own score, so one weak package cannot hide behind the combined
  average. A package's own `.codediag.yml` can set its own value. Failing
  packages are named on stderr, in error annotations and the job summary,
  and marked in the terminal, Markdown, HTML, and pull request comment
  reports; the JSON report records each package's `threshold`.
- `failOn` in `.codediag.yml`, `--fail-on`, and the Action's `fail-on` input
  fail the scan on any active finding at or above `critical`, `warning`, or
  `info`, whatever the score. Suppressed and baseline findings do not count,
  and with `--changed-since` only the changed files do.
- VS Code extension 0.6.0: remediation quick fixes, offered as the preferred
  fix where a rule has one mechanical fix on the flagged line: enable TLS
  certificate verification, verify JWT expiration, and remove `"none"` from a
  JWT `algorithms` list.

### Known limitations

- tRPC: auth applied outside the procedure (at the adapter mount, in a
  Next.js `middleware.ts`, or by a throwing `createContext`) is not seen,
  intentionally public mutations are reported like any other, and tRPC v9
  routers are not supported.
- Git history secrets: only the checked-out branch is read, merge commits are
  skipped, and a history rewrite that keeps a secret changes its fingerprint.
- Field taint is instance-insensitive: any `new X(requestData)` taints `X`'s
  fields. Fields written by a base class or from outside the class,
  `super()` calls, and `Object.assign(this, ...)` are not followed.

### Fixed

- Shell command and SQL findings did not count NestJS `@Param()`,
  `@Query()`, `@Body()`, or `@Headers()` parameters as request data unless
  their text named the request, so they stayed warnings. Parameters behind a
  parsing pipe (`ParseIntPipe`, `ParseUUIDPipe`, ...) are no longer request
  data for any sink.
- GitHub Action annotation messages escaped commas and colons as workflow
  command properties do, so GitHub showed them as `%2C` and `%3A`; only
  properties are escaped that way now.
- The JSON schema rejected combined workspace reports with a Hono package.

## [0.7.0] - 2026-10-30

The "Across" release: request data is followed through helper functions and
services, whole monorepos are scanned as one report, Hono joins the API
analyzers, scores are tracked over time, and pull request comments measure
against the base branch.

### Added

- Cross-file taint: when a sink's value comes from a parameter of a project
  function (named, default, renamed, namespace, or `require()` imports,
  object and class methods, and NestJS services called as
  `this.service.method(dto.x)`), the function's call sites are checked, and
  a caller that passes request data makes the sink request-controlled. A
  function whose returned value is request data makes its result request data
  at the call site. Traces cross at most two function boundaries, findings
  stay at the sink line with unchanged messages and fingerprints, get
  `confidence: "medium"`, and name the calling line in the fix. URL and HTML
  sinks judge each caller's whole argument, so fixed origins and JSON
  responses stay unreported.
- `--workspaces` scans every package of an npm, pnpm, or Yarn workspace, a
  Lerna repository, or an Nx workspace (Turborepo is reported as the tool when
  it orchestrates the workspaces). Each package is scanned with its own stack
  detection and its own `.codediag.yml`, or the root configuration with root
  `ignore` paths rebased into the package. The combined report averages each
  analyzer over the packages it ran in, uses the usual analyzer weights for
  the total, lists the packages (`workspace` in JSON), locates findings
  relative to the root (project-level findings point at the package's
  `package.json`), and mixes the package path into fingerprints, so
  baselines, `--compare`, `--changed-since`, and SARIF work across the
  repository. Scanning a workspace root without the flag suggests it. The
  GitHub Action has a matching `workspaces` input.
- Hono API Health analysis: routes on `new Hono()` apps, `basePath()`, and
  sub-apps mounted with `app.route()` across files, replayed in Hono's
  registration order; auth from route middleware or an earlier matching
  `app.use()` (`jwt()`, `bearerAuth()`, `basicAuth()`, Clerk, Auth.js, or a
  custom middleware); body validators such as `zValidator('json', ...)`;
  `onError`; and health endpoints. New rules: `no-hono-routes`,
  `missing-hono-auth-middleware`, `missing-hono-validator`, and
  `missing-hono-error-handler`. Hono servers are also checked for secure
  headers (`hono/secure-headers`), rate limiting (`hono-rate-limiter`), and
  open CORS (`hono/cors` without an origin).
- `--history <directory>` records each scan in the directory and shows the
  total score over the last 50 recorded scans: a sparkline in the terminal and
  Markdown, and a line chart with grade guides, keyboard-reachable readouts,
  and a table view in the HTML report. JSON gets an optional `history` array.
- The GitHub Action's `compare` input takes a JSON report of the base branch:
  the pull request comment shows the score change against it with new and
  fixed counts and marks new findings, and the job summary and report carry
  the comparison.
- Vulnerability findings name the affected packages with advisory titles and
  links (npm, pnpm, Yarn Classic, and Yarn Berry), in the fix text so
  fingerprints are unchanged. `audit: production` audits only production
  dependencies.
- The `--format prompt` handoff groups findings by rule with each rule's
  title, description, CWE and OWASP mappings, and documentation link.

### Changed

- The weighted total moved to `weightedTotal()` in `src/core/scoring.ts`, and
  `calculateGrade()` is exported from the scanner.
- `audit` in `.codediag.yml` accepts `true`, `false`, or `production`.
- All runtime files are parsed before security sinks are inspected, so the
  type checker's program is built once; CodeDiag's own scan got faster
  despite the cross-file pass.
- `dynamic-command-execution`, `dynamic-sql-query`, and `path-traversal`
  descriptions mention values passed in by callers.

### Known limitations

- Cross-file taint does not follow constructors, callbacks such as
  `items.map(helper)`, `.call`/`.apply`/`.bind`, rest or spread arguments,
  data stored on objects or in module state, or methods reached through an
  interface or a dependency injection token; a `startsWith()` path check in
  the caller does not clear a finding in the helper.
- Hono: `clerkMiddleware()` alone counts as auth, path-less
  `app.use(mw).get(...)` chains are not followed, route paths must be
  literals, and Hono routes inside a Next.js catch-all are left to the Next.js
  analyzer.
- Workspaces: packages are scanned one after another, and each runs its own
  dependency audit; Nx projects without a `package.json` skip the dependency
  analyzer.

## [0.6.0] - 2026-10-30

The "Deep Scan" release: Fastify support, JWT and session misconfiguration,
template injection, prototype pollution, secret scanning beyond source code,
comparisons between scans, changed-files mode, a redesigned HTML report, and
VS Code quick fixes.

### Added

- Fastify API Health analysis: routes from `fastify.get()` and
  `fastify.route()` on instances, typed plugins, and `register()`-ed plugin
  functions; auth from `onRequest`, `preParsing`, `preValidation`, and
  `preHandler` hooks on the route or anywhere in its encapsulation context
  (Fastify applies a context's hooks to routes registered before them), from
  `fastify-plugin` plugins, and from `@fastify/bearer-auth`; body schemas;
  `setErrorHandler`; and health endpoints. New rules: `no-fastify-routes`,
  `missing-auth-hook`, `missing-route-schema`, and `missing-error-handler`.
  A NestJS app on `@nestjs/platform-fastify` is still analyzed as NestJS.
- `jwt-none-algorithm` (critical): JWT options that list `none` in
  `algorithms` or set `algorithm: 'none'`, and jose's `UnsecuredJWT`.
- `jwt-expiration-ignored`: `ignoreExpiration: true` in jsonwebtoken,
  passport-jwt, or @nestjs/jwt options.
- `insecure-cookie`: session or token cookies set with `res.cookie()`,
  `reply.setCookie()`, or `cookies().set()` without `httpOnly: true` and
  `secure: true`, and express-session, cookie-session, or @fastify/session
  options that turn either flag off.
- `server-side-template-injection` (critical): request data compiled or
  rendered as an EJS, Pug, Handlebars, Nunjucks, Eta, doT, or lodash template.
- `prototype-pollution`: nested writes such as `target[a][b] = value` with
  keys from request data (critical), and recursive merges that copy keys
  without rejecting `__proto__`, `constructor`, and `prototype` (warning).
- `hardcoded-secret` now also scans JSON, YAML, TOML, INI, XML, properties,
  Dockerfiles, `.npmrc`, and `.yarnrc` for provider tokens (private keys, AWS,
  GitHub, Stripe live, Slack, npm, Google, Anthropic, OpenAI, SendGrid, and
  database URLs with passwords) and for long, high-entropy values of
  secret-like keys. Placeholders, `${VARIABLE}` references, paths, and lock
  files are skipped.
- `committed-env-secret` (critical): secrets in `.env` files that Git tracks.
  Untracked and ignored `.env` files are never read.
- `--compare <report.json>`: score and analyzer deltas, new findings (marked
  `isNew`), and fixed findings since an earlier JSON report, in every output
  format. SARIF results get `baselineState`, and JSON gets an optional
  `comparison` object.
- `--changed-since <revision>`: report and score only findings in files
  changed since a Git revision (commits since the merge base, staged and
  unstaged edits, and untracked files). JSON gets an optional `scope` object.
  It cannot be combined with `--update-baseline`.
- `ScanContext.isExcluded()` for paths that file discovery does not index.

### Changed

- `dynamic-command-execution` also covers `spawn()`, `spawnSync()`,
  `execFile()`, and `execFileSync()` with a `shell` option and non-literal
  arguments.
- The HTML report was redesigned: a score gauge, analyzer weights and
  deltas, a change panel and scope banner, text search, a "New" filter, links
  to each rule's documentation, findings ordered by severity, and print
  styles. It still loads nothing from the network.
- The project page was redesigned, and its fonts now load (the previous
  "Satoshi" font was never served by Google Fonts).
- Request-data taint tracking moved to `src/analyzers/taint.ts`, shared by
  the sink, injection, and auth rules.
- Analyzer weights moved to `src/core/scoring.ts` (`ANALYZER_WEIGHTS`).
- The README's example pull request comment now adds up.
- Updated ignore to 7.0.13, Biome to 2.6.2, and tsup to 9.0.0, with the
  Action bundle rebuilt.

### Fixed

- The `bin` path in `package.json` no longer triggers npm's "script name was
  invalid" warning when publishing.
- The Action bundle embeds only the package version instead of the whole
  `package.json`, so dependency updates no longer require a rebuilt bundle.
- The symlink discovery test is skipped where the platform cannot create
  symbolic links (Windows without Developer Mode) instead of failing.

### Known limitations

- Fastify plugins loaded with `@fastify/autoload` are not followed, so their
  hooks and prefixes do not apply to the routes they load.
- Fastify auth and validation are recognized by names and visible hook
  bodies, as for Express; validation inside a handler is not counted.

## [0.5.0] - 2026-10-04

Pull request comments: the GitHub Action can keep one comment on each pull
request with the score and the findings in the files it changes.

### Added

- Pull request comments: with `comment: true`, the GitHub Action keeps one
  comment on the pull request with the score, its change since the last
  run, the analyzer table, and the findings in files the pull request
  changes. Later pushes update the same comment. A comment that cannot be
  written only logs a warning.

## [0.4.0] - 2026-10-04

Web security sinks: request data that reaches a file path, an outgoing
request, a redirect, or an HTML response is now reported.

### Added

- Four taint-based security rules: `path-traversal` (CWE-22),
  `server-side-request-forgery` (CWE-918), `open-redirect` (CWE-601), and
  `reflected-xss` (CWE-79). They report request data that reaches a file
  path, an outgoing request's host, a redirect target, or an HTML response.
  NestJS `@Query()`, `@Param()`, `@Body()`, and `@Headers()` parameters
  count as request data. Function results, sanitized values, fixed-origin
  URLs, same-site paths, and server-set request fields such as `req.user`
  are not reported.

### Changed

- Updated commander to 14, TypeScript to 6, and Biome to 2.5.15.
- Documentation uses the `v0` Action tag instead of `main`.

## [0.3.0] - 2026-10-04

The "Reliable Engine" release: faster, gitignore-aware discovery, a rule
registry, explainable scoring, suppressions and baselines, offline scans, and
precision fixes for Express, NestJS, and security sinks.

### Added

- A shared scan context: files are discovered once, read once, and parsed by a
  single ts-morph project for all analyzers.
- `.gitignore` support for source discovery, including nested files and parent
  directories up to the Git root.
- `maxFileSizeKb` configuration (default 512) and an optional `skipped` summary
  in JSON output for oversized, minified, or unreadable code files.
- A rule registry (`src/rules/registry.ts`) with titles, descriptions, default
  severities, CWE and OWASP mappings for all 66 rules, and generated rule
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
  `knex`, and similar names. Each scope is indexed once and taint results
  are memoized, so a file with 1,500 SQL sinks is analyzed in about 0.5 s
  instead of 23 s.
- Coverage thresholds are recognized from real configuration: Jest
  `coverageThreshold`, Vitest `coverage.thresholds` (or 0.x metric keys) in
  `vitest.config.*` or `vite.config.*`, node:test `--test-coverage-*` flags,
  and c8/nyc options. Mentioning "coverage" in a comment or enabling coverage
  without thresholds no longer counts.
- `hardcoded-secret` ignores values built with `${...}` interpolation and
  reports the first literal credential in a file instead.

### Security

- `npm audit fix` updated vulnerable transitive development dependencies.
  Production dependencies report no known vulnerabilities. Six high-severity
  advisories remain in `braces`, reached only through the development tool
  `@vscode/vsce` (via `secretlint` and `globby`), for which no patched
  `braces` release exists yet.

## [0.2.0] - 2026-07-17

### Added

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
