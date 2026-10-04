# Security analysis

CodeDiag combines source scanning with framework-aware checks. The security
analyzer is designed to catch high-signal mistakes during local development and
CI without requiring a service or a vulnerability database.

## Checks

The analyzer currently reports:

- hardcoded API keys, tokens, and credentials in source code (values built
  with `${...}` interpolation are ignored);
- missing `.env` protection in `.gitignore`;
- missing runtime Helmet and rate-limit middleware in supported web servers;
- open CORS configuration;
- weak password hashing, direct plaintext comparison, and likely unhashed
  password persistence;
- `eval()` and the `Function` constructor;
- non-literal commands passed to imported `child_process.exec()` or
  `execSync()` bindings;
- dynamic SQL passed to common query methods or explicitly unsafe ORM methods,
  and SQL built from request data passed to a query method on any client;
- local or global TLS certificate verification bypasses;
- path traversal: request data used as a path for `fs`, `fs/promises`, or
  `fs-extra` calls, or for `res.sendFile()`/`res.download()` without a
  `root` option;
- server-side request forgery: request data that decides the scheme or host
  of a `fetch`, axios, got, ky, needle, `http(s)`, superagent, undici, or
  NestJS `HttpService` request;
- open redirects: request data used as the target of `res.redirect()`,
  `reply.redirect()`, or `NextResponse.redirect()`;
- reflected XSS: request data written into `res.send()`, `res.write()`, or
  `res.end()` (Express serves strings as HTML), or into a `Response` with a
  `text/html` content type.

Runtime sink checks use the TypeScript syntax tree and recognize aliased ESM
imports, namespace imports, and CommonJS `require()` bindings.

A dynamic shell or SQL value is critical when it comes from request data:
`req`/`request`/`ctx` properties, `process.argv`, Next.js `request.json()`,
or `searchParams`. CodeDiag follows the value back through variable
declarations, destructuring, and reassignments in the enclosing scopes, up to
three assignments, so this is critical:

```ts
const { id } = req.params;
const sql = "SELECT * FROM users WHERE id = " + id;
await myDb.query(sql);
```

Other non-literal values are warnings.

The path traversal, SSRF, open redirect, and XSS checks report only values
that are request data themselves, followed through the same variables. A
function's result is not request data, so `db.find(req.params.id)` and
`await repo.pathFor(req.params.id)` are not reported, and neither are values
wrapped in `path.basename()`, `encodeURIComponent()`, `Number()`, or an
escaping function. Values the server sets on the request (`req.user`,
`req.session`, multer's `req.file`) are not request data. These are also not
reported:

```ts
// The origin is fixed before the request data.
await fetch(`${API_BASE}/users/${req.params.id}`);
// A same-site path: one leading slash and a fixed first segment.
res.redirect(`/orders/${req.params.id}`);
// Express rejects `..` segments when a root directory is given.
res.sendFile(req.params.name, { root: PUBLIC_DIR });
// The resolved path is checked against its base directory.
const file = path.resolve(ROOT, req.query.file);
if (!file.startsWith(ROOT + path.sep)) throw new Forbidden();
await readFile(file);
```

Path traversal and reflected XSS are critical. SSRF and open redirects are
warnings, because fetching or redirecting to a user-supplied URL is
sometimes the feature (webhooks, link previews, sign-in return URLs); add an
allowlist and suppress the finding with the reason. Dynamic code execution and disabled
TLS verification are always critical. Taint tracking stays within a function
and its enclosing scopes; values passed through helper functions are not
followed yet (see the [roadmap](roadmap.md)).

## Scope

Runtime checks inspect JavaScript and TypeScript files found by CodeDiag's
gitignore-aware discovery, which skips `node_modules`, build output, and
minified bundles. Test and fixture paths
such as `*.test.ts`, `*.spec.ts`, `__tests__/`, `test/`, and `tests/` are excluded
so intentionally unsafe examples do not affect the production score. Files and
directories configured under `.codediag.yml` `ignore` are also excluded:

```yaml
ignore:
  - node_modules
  - dist
  - generated/**
  - vendor/**
```

Use narrow ignore patterns and document why generated or third-party code is
excluded. To accept a specific finding instead, suppress it in source with a
reason, change the rule in `.codediag.yml`, or record existing findings in a
baseline; see [suppressions and baselines](suppressions-and-baselines.md).
Run `codediag explain <rule>` for any rule's details.

## Limits

The analysis is intentionally conservative. It does not perform whole-program
taint tracking, inspect Git history for removed secrets, prove authorization
correctness, or replace dependency advisories and a full SAST review. Dynamic
imports, wrapper functions, custom database APIs, and values assembled across
multiple modules may not be recognized.

Treat findings as review prompts with source locations and fixes. A clean scan
means the implemented checks passed; it is not proof that an application is
secure.
