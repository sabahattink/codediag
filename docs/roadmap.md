# Roadmap

CodeDiag 0.3 made the engine reliable; 0.4 through 0.6 widened what it sees
(web security sinks, pull request comments, Fastify, JWT and session
misconfiguration, template injection, prototype pollution, secret scanning
beyond code, comparisons between scans, and changed-files mode), and 0.7
reached across files and repositories: cross-file taint, monorepo workspaces,
Hono, score history, base-branch deltas, and audit details. These are the next
candidates, roughly in priority order. Each one should ship with realistic and
defect fixtures in `tests/fixtures/` and keep the benchmark tests green.

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
- **Persistent audit cache:** reuse dependency audit results across runs,
  keyed by the lock file hash, so repeated and workspace scans stay fast.

## Frameworks

- **tRPC** procedures (protected versus public procedures, input
  validation).
- **Remix / React Router and SvelteKit** server endpoints.

## Monorepos and pull requests

- **Parallel workspace scans:** scan workspace packages concurrently and
  share one dependency audit per lock file.
- **Per-package thresholds:** gate each workspace package on its own score as
  well as the combined one.

## Editor

- **Incremental scans** in a worker so the VS Code extension host never
  blocks, re-analyzing only changed files.
- **Remediation quick fixes** beyond suppressions, for rules with a safe
  mechanical fix. (Suppress and explain quick fixes shipped in 0.6.)
- **Marketplace and Open VSX publishing.**

## Out of scope

CodeDiag will not upload source code, require an account, or apply changes
automatically. Fix plans and prompts stay review-only.
