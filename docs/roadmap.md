# Roadmap

CodeDiag 0.3 made the engine reliable; 0.4 through 0.6 widened what it sees:
web security sinks, pull request comments, Fastify, JWT and session
misconfiguration, template injection, prototype pollution, secret scanning
beyond code, comparisons between scans, and changed-files mode. These are the
next candidates, roughly in priority order. Each one should ship with
realistic and defect fixtures in `tests/fixtures/` and keep the benchmark
tests green.

## Precision and depth

- **Deeper cross-file taint:** helper functions and service methods are
  followed two calls deep; still missing are request data stored on objects
  (`this.name = req.query.name`) or module state, callbacks and
  constructors, and methods reached through an interface or a dependency
  injection token instead of the class.
- **Fastify autoload:** follow `@fastify/autoload` directories so hooks and
  prefixes from autoloaded plugins apply to their routes.
- **Secret scanning in Git history:** report credentials that were committed
  and later removed, with the same redaction as today.
- **Dependency audit options:** production-only audits, audit result caching
  keyed by the lock file hash, and advisory-level details in reports.

## Frameworks

- **tRPC** procedures (protected versus public procedures, input
  validation).
- **Remix / React Router and SvelteKit** server endpoints.

## Monorepos and pull requests

- **Workspace awareness:** detect npm, pnpm, and Yarn workspaces, Nx, and
  Turborepo; score each package and report a combined result.
- **Base-branch delta in pull request comments:** compare against the base
  branch's report with `--compare`, not only the previous comment's score.
- **History view:** keep several reports and chart the score over time in the
  HTML report. (Comparing with one earlier report shipped in 0.6.)

## Editor

- **Incremental scans** in a worker so the VS Code extension host never
  blocks, re-analyzing only changed files.
- **Remediation quick fixes** beyond suppressions, for rules with a safe
  mechanical fix. (Suppress and explain quick fixes shipped in 0.6.)
- **Marketplace and Open VSX publishing.**

## AI handoff

- Richer `--format prompt` output that groups related findings and includes
  the rule documentation, still review-only and without source contents.

## Out of scope

CodeDiag will not upload source code, require an account, or apply changes
automatically. Fix plans and prompts stay review-only.
