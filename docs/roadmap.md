# Roadmap

CodeDiag 0.3 made the engine reliable; 0.4 through 0.6 widened what it sees
(web security sinks, pull request comments, Fastify, JWT and session
misconfiguration, template injection, prototype pollution, secret scanning
beyond code, comparisons between scans, and changed-files mode); 0.7 reached
across files and repositories (cross-file taint, monorepo workspaces, Hono,
score history, base-branch deltas, and audit details); and 0.8 went deeper:
tRPC, taint through fields, constructors, callbacks, and injected providers,
`@fastify/autoload`, secrets kept in Git history, per-package and severity
gates, and remediation quick fixes. These are the next candidates, roughly in
priority order. Each one should ship with realistic and defect fixtures in
`tests/fixtures/` and keep the benchmark tests green.

## Precision and depth

- **Instance-sensitive taint:** today any `new X(requestData)` taints the
  fields of every `X`; still missing are fields written by a base class or
  from outside the class, `super()` calls, `Object.assign(this, ...)`,
  property writes on module objects, and factory providers (`useFactory`,
  `useValue`).
- **Auth outside tRPC procedures:** recognize authentication applied at the
  adapter mount, in a Next.js `middleware.ts`, or by a `createContext` that
  rejects anonymous callers, and an opt-out for intentionally public
  mutations.
- **Git history beyond HEAD:** other branches and tags, and merge commits.
- **Persistent audit cache:** reuse dependency audit results across runs,
  keyed by the lock file hash, so repeated and workspace scans stay fast.

## Frameworks

- **Remix / React Router and SvelteKit** server endpoints.
- **tRPC v9** routers and standalone tRPC servers' security headers.

## Monorepos and pull requests

- **Parallel workspace scans:** scan workspace packages concurrently and
  share one dependency audit per lock file.

## Editor

- **Incremental scans** in a worker so the VS Code extension host never
  blocks, re-analyzing only changed files.
- **More remediation quick fixes** for rules with a safe mechanical fix.
  (TLS verification, JWT expiration, and the JWT `none` algorithm shipped in
  0.8.)
- **Marketplace and Open VSX publishing.**

## Out of scope

CodeDiag will not upload source code, require an account, or apply changes
automatically. Fix plans and prompts stay review-only, and quick fixes apply
only when you choose them.
