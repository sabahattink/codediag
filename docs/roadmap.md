# Roadmap

CodeDiag 0.3 made the engine reliable: fast gitignore-aware discovery, a rule
registry, explainable scoring, suppressions, baselines, and precision fixes.
These are the next candidates, roughly in priority order. Each one should ship
with realistic and defect fixtures in `tests/fixtures/` and keep the
benchmark tests green.

## Precision and depth

- **More security sinks with taint tracking:** path traversal
  (`fs.readFile(req.params.file)`), server-side request forgery
  (`fetch(req.query.url)`), reflected XSS (`res.send(req.query.x)`), open
  redirects, prototype pollution through deep merges, and
  `child_process.spawn(..., { shell: true })`.
- **JWT and session misconfiguration:** `algorithms: ['none']`,
  `ignoreExpiration: true`, missing `httpOnly`/`secure` cookie flags.
- **Cross-file taint:** follow request data through helper functions and
  service calls, not only within one function.
- **Secret scanning beyond code:** committed `.env` files, JSON, YAML,
  Dockerfiles, and high-entropy strings, with redaction in every output.
- **Dependency audit options:** production-only audits, audit result caching
  keyed by the lock file hash, and advisory-level details in reports.

## Frameworks

- **Fastify and Hono** API analyzers (routes, auth hooks, schemas).
- **tRPC** procedures (protected versus public procedures, input
  validation).
- **Remix / React Router and SvelteKit** server endpoints.

## Monorepos and pull requests

- **Workspace awareness:** detect npm, pnpm, and Yarn workspaces, Nx, and
  Turborepo; score each package and report a combined result.
- **Changed-files mode:** `--changed-since origin/main` to report findings
  only in files a pull request touches.
- **Pull request comments:** an Action option that posts or updates a single
  summary comment with the score delta.
- **Trends:** `--compare previous.json` to show score and finding changes,
  and a history view in the HTML report.

## Editor

- **Incremental scans** in a worker so the VS Code extension host never
  blocks, re-analyzing only changed files.
- **Quick fixes:** code actions that insert a suppression comment with a
  reason, or apply simple remediations.
- **Marketplace and Open VSX publishing.**

## AI handoff

- Richer `--format prompt` output that groups related findings and includes
  the rule documentation, still review-only and without source contents.

## Out of scope

CodeDiag will not upload source code, require an account, or apply changes
automatically. Fix plans and prompts stay review-only.
