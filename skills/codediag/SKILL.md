---
name: codediag
description: Find the API routes, form actions, and tRPC procedures in a Node.js project that anyone can call, because they have no auth check or no input validation, find Supabase tables without row level security, and run a CodeDiag health scan (security, dependencies, tests, structure). Covers Next.js, SvelteKit, React Router/Remix, Express, Fastify, Hono, Elysia, NestJS, and tRPC. Use when the user asks which routes are unprotected or public, whether an API is missing auth or validation, whether Supabase RLS is set up, for a security review of a Node.js backend, or for a check before shipping.
license: MIT
compatibility: Needs Node.js 20.19 or newer and npx. Runs offline unless a dependency audit is requested.
---

# CodeDiag

CodeDiag finds routes with no recognizable auth check or input validation. It models where auth actually runs in each framework instead of searching for the word "auth".

## 1. Run it

If the CodeDiag MCP tools are available, use them:

- `find_unprotected_routes` — routes without an auth check or input validation (`check`: `auth`, `validation`, or `both`).
- `scan_project` — the 0–100 health score and every finding, most severe first.
- `explain_rule` — what a rule ID means and how to suppress it.

Pass the project's absolute path as `path`; the server may run in another directory. Check that the `directory` in the result is the project you meant.

Otherwise run the CLI from the project root and read the JSON:

```bash
npx -y @sabahattink/codediag scan . --format json --no-audit
```

Findings are in `analyzers[].issues[]`, each with `rule`, `severity`, `message`, `file`, `line`, and often `fix`. Skip issues that carry a `suppression`. The route findings are these rule IDs in the "API Health" analyzer:

- **No auth check:** `missing-auth-check`, `missing-auth-middleware`, `missing-auth-hook`, `missing-guard`, `missing-hono-auth-middleware`, `missing-elysia-auth`, `missing-sveltekit-auth`, `missing-react-router-auth`, `react-router-loader-auth-only`, `missing-trpc-auth-middleware`
- **No input validation:** `missing-request-validation`, `missing-validation-middleware`, `missing-route-schema`, `missing-dto`, `dto-not-validated`, `missing-hono-validator`, `missing-elysia-validation`, `missing-sveltekit-validation`, `missing-react-router-validation`, `unvalidated-trpc-input`

In Supabase projects, the "Security" analyzer also reads `supabase/migrations`: `supabase-table-without-rls` is a table the API exposes with row level security never enabled, and `supabase-permissive-policy` is a write policy whose `using` or `with check` is `true`. Fix the first with `alter table … enable row level security;` plus policies for the access the app needs.

`npx -y @sabahattink/codediag explain <rule-id>` explains any rule. Drop `--no-audit` only if the user agrees to a network call to the package registry.

## 2. Verify before you report

This is static analysis. "No recognizable auth check" means CodeDiag could not see one, not that there is none. For each finding, open the file at the reported line and check where auth runs for that framework:

| Framework | Where auth runs before the handler |
|---|---|
| Next.js | `middleware.ts` or `proxy.ts` for paths its `matcher` covers; a session check inside the route handler |
| SvelteKit | the `handle` hook in `src/hooks.server.ts`, including `sequence()` parts; a `locals.user` check inside the action or `+server` handler. A layout `load` does not run before form actions. |
| React Router / Remix | the action or loader itself; route `middleware`. A parent route's loader does not run before a child's action. |
| Express, Fastify, Hono | middleware, hooks, or `use()` calls registered before the route |
| Elysia | `onBeforeHandle()`, a `resolve()` that returns `status(401)`, `guard()`, or an auth macro (`{ auth: true }`) registered before the route; `onRequest()`; a check inside the handler. A plugin's hooks reach the instance that uses it only with `{ as: 'scoped' }` or `{ as: 'global' }`. |
| NestJS | `@UseGuards` on the controller or method, or a global guard |
| tRPC | a protected procedure's middleware, or a `createContext` that rejects anonymous callers in front of every adapter |

Some routes are public on purpose: sign-in and sign-up, health checks, webhooks that verify a signature, public read endpoints. Say so instead of calling them vulnerable.

## 3. Report

List the findings that hold up, most severe first. For each one give the method and path, `file:line`, what is missing, and the fix for that framework. Do not claim a route is exploitable unless you verified it. Mention the overall score only when the user asked about overall health.

## 4. Fix, when the user asks

- Put the auth check where the framework runs it before the handler (table above), not in a layout or a parent loader.
- Parse the request body with the project's existing schema library (Zod, Valibot, class-validator, and so on) before using it.
- For a route that is public on purpose, add this comment on the line above the reported line:
  `// codediag-ignore-next-line <rule-id> -- <why this is acceptable>`
- Run the scan again to confirm the finding is gone.
