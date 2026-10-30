# Security analysis

CodeDiag combines source scanning with framework-aware checks. The security
analyzer is designed to catch high-signal mistakes during local development and
CI without requiring a service or a vulnerability database.

## Checks

The analyzer currently reports:

- hardcoded API keys, tokens, and credentials in source code (values built
  with `${...}` interpolation are ignored);
- credentials in configuration files: JSON, YAML, TOML, INI, XML,
  properties, Dockerfiles, `.npmrc`, and `.yarnrc`. Provider formats (private
  keys, AWS, GitHub, Stripe live, Slack, npm, Google, Anthropic, OpenAI, and
  SendGrid keys, and database URLs with a password) are reported wherever
  they appear; keys named like `password`, `secret`, `token`, or `apiKey` only
  when their value is long (12+ characters), random (3.5+ bits per
  character), and not a placeholder, path, or `${VARIABLE}` reference. Lock
  files are skipped;
- secrets in `.env` files that Git tracks (`committed-env-secret`); ignored
  `.env` files are your local configuration and are never read;
- JWT options that accept the `none` algorithm or `ignoreExpiration: true`,
  and jose's `UnsecuredJWT`;
- session or token cookies (names containing session, sid, token, jwt, or
  auth) set without `httpOnly: true` and `secure: true`, and session
  middleware that sets either flag to `false`;
- missing `.env` protection in `.gitignore`;
- missing runtime Helmet and rate-limit middleware in supported web servers;
- open CORS configuration;
- weak password hashing, direct plaintext comparison, and likely unhashed
  password persistence;
- `eval()` and the `Function` constructor;
- non-literal commands passed to imported `child_process.exec()` or
  `execSync()` bindings, or to `spawn()`, `spawnSync()`, `execFile()`, or
  `execFileSync()` with a `shell` option;
- server-side template injection: request data used as the template source
  of EJS, Pug, Handlebars, Nunjucks, Eta, doT, or lodash `template()`;
- prototype pollution: nested writes such as `target[a][b] = value` with a
  key from request data (critical), and recursive merge functions that copy
  keys without rejecting `__proto__`, `constructor`, and `prototype`
  (warning);
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
three assignments, and through the project's helper functions (see
[below](#helper-functions-and-services)), so this is critical:

```ts
const { id } = req.params;
const sql = "SELECT * FROM users WHERE id = " + id;
await myDb.query(sql);
```

Other non-literal values are warnings.

The path traversal, SSRF, open redirect, and XSS checks report only values
that are request data themselves, followed through the same variables.
NestJS parameters injected with `@Query()`, `@Param()`, `@Body()`, or
`@Headers()` are request data too, and so is a tRPC procedure's input inside
the resolver passed to `.query()`, `.mutation()`, or `.subscription()`:
`({ input }) => ...` (and fields destructured from it) or `opts.input`.
Input that passed `.input(schema)` still counts, because the caller chose it:

```ts
// Critical: z.string() checks the type, not what the shell does with it.
publicProcedure.input(z.string()).mutation(({ input }) => exec(`gzip ${input}`));
```

A
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
TLS verification are always critical.

### Helper functions and services

Request data is also followed through the project's own functions, across
files:

- **Into helpers.** When a sink's value comes from a parameter of a project
  function, CodeDiag checks the function's call sites. If one passes request
  data for that parameter, the sink is reported. This covers plain and arrow
  functions, imports (named, default, renamed, namespace, and `require()`),
  object methods, and class methods called on an instance or through
  `this.service.method()`, including NestJS services injected through the
  constructor.
- **Out of helpers.** A project function whose returned value is request
  data makes its result request data: `function getName(req) { return
  req.query.name; }` or `const pick = (query) => query.file` called with
  `req.query`. Other results still are not request data, so a database
  lookup, `basename()`, `Number()`, or an escaping function inside the helper
  ends the trace.

```ts
// src/lib/files.ts: reported here, at the file call
export function readUpload(name: string) {
  return fs.readFile(path.join(UPLOADS, name));
}
// src/routes/files.ts
app.get("/f", (req, res) => readUpload(req.query.name));
```

The finding stays at the sink, with the same message, so suppressions and
fingerprints stay where the dangerous call is. It has medium confidence, and
when a caller passes the data in, its fix names that call: "Request data
reaches this call from src/routes/files.ts:12; ...". A shell or SQL warning
that becomes critical this way is still one finding. URL and HTML sinks judge
what each caller passes as a whole, so
``apiGet(`https://api.example.com/users/${id}`)`` keeps the origin fixed
inside `apiGet(url)`, and `reply(res, req.body)` still counts as JSON.

Functions are resolved with TypeScript's type checker. Only functions in the
scanned runtime files are followed (never `node_modules`, declaration files,
or tests), calls from test files do not count, and a trace crosses at most
two function boundaries, such as a route calling a helper that calls another
helper. A helper that only ever receives constants is not upgraded.

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
excluded. The same `ignore` patterns apply to `.env` and `.npmrc` files that
Git tracks.

No finding includes a secret's value: messages name the kind of credential
(`Possible GitHub token in a configuration file`) or its key, and
fingerprints for these rules never hash the line. To accept a specific finding instead, suppress it in source with a
reason, change the rule in `.codediag.yml`, or record existing findings in a
baseline; see [suppressions and baselines](suppressions-and-baselines.md).
Run `codediag explain <rule>` for any rule's details.

## Limits

The analysis is intentionally conservative. It does not perform whole-program
taint tracking, inspect Git history for removed secrets, prove authorization
correctness, or replace dependency advisories and a full SAST review. Dynamic
imports, custom database APIs, and values assembled in other ways may not be
recognized. Across functions in particular, CodeDiag does not follow:

- chains longer than two calls, constructors, callbacks passed to other
  functions (`items.map(helper)`), `.call()`/`.apply()`/`.bind()`, rest
  parameters, or spread arguments;
- calls that cannot be matched to the function: methods on a value whose
  type is unknown (an untyped JavaScript parameter), methods reached through
  an interface or a dependency injection token instead of the class, and
  calls through a name re-exported under an alias;
- request data stored on an object (`this.name = req.query.name`) or in
  module state and read elsewhere;
- a whole request object passed to a helper under another name, unless the
  helper reads `body`, `params`, or `query` from it (`function f(r) { return
  r.query.name; }` is followed; `r.headers.host` is not).

Treat findings as review prompts with source locations and fixes. A clean scan
means the implemented checks passed; it is not proof that an application is
secure.
