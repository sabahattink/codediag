# Roadmap

CodeDiag 0.3 made the engine reliable; 0.4 through 0.6 widened what it sees
(web security sinks, pull request comments, Fastify, JWT and session
misconfiguration, template injection, prototype pollution, secret scanning
beyond code, comparisons between scans, and changed-files mode); 0.7 reached
across files and repositories (cross-file taint, monorepo workspaces, Hono,
score history, base-branch deltas, and audit details); and 0.8 went deeper:
tRPC, taint through fields, constructors, callbacks, and injected providers,
`@fastify/autoload`, secrets kept in Git history, per-package and severity
gates, and remediation quick fixes; 0.9 recognized tRPC auth in front of the
procedures and made audits cached and concurrent; and 0.10 reached SvelteKit
and React Router, judged Next.js middleware per route, and split pnpm
workspace audits by package. These are the next candidates, roughly in
priority order. Each one should ship with realistic and defect fixtures in
`tests/fixtures/` and keep the benchmark tests green.

## Precision and depth

- **Instance-sensitive taint:** today any `new X(requestData)` taints the
  fields of every `X`; still missing are fields written by a base class or
  from outside the class, `super()` calls, `Object.assign(this, ...)`,
  property writes on module objects, and factory providers (`useFactory`,
  `useValue`).
- **Sanitizers in taint tracking:** a same-site check such as Remix's
  `safeRedirect()`, or a path normalized with `replace(/\/+/g, "/")`, still
  reads as tainted, which keeps an open-redirect rule for React Router
  `redirect()` out of reach.
- **Auth in front of a server:** auth enforced by an Express server in
  front of a React Router or SvelteKit request handler, and a SvelteKit
  `handle` guard on the tRPC path, are not counted yet.
- **Git history beyond HEAD:** other branches and tags, and merge commits.

## Frameworks

- **Route conventions:** `remix-flat-routes` (Epic Stack's `+` folders and
  `remixRoutesOptionAdapter`), Remix v1's nested folders, and SvelteKit
  remote functions (`*.remote.ts`).
- **tRPC v9** routers and standalone tRPC servers' security headers.

## Monorepos and pull requests

- **Parallel workspace analysis:** package audits already run
  concurrently; the analysis itself still runs one package at a time.

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
