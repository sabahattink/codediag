# CodeDiag rules

<!-- Generated from src/rules/registry.ts by `npm run docs:rules`. Do not edit by hand. -->

Every finding carries one of these rule IDs. SARIF output links each rule
to its section here through `helpUri`.

With scoring version 2, a finding whose root cause is also reported is
downgraded to `info`, marked with `causedBy`, and costs no points.

## API Health

### dto-not-validated

**DTOs without ValidationPipe** · default severity: `warning`

Endpoints take DTO classes, but no global, controller, method, or parameter ValidationPipe validates them, so class-validator rules are never enforced.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### implicit-pages-methods

**Pages API route without method branches** · default severity: `info`

A Pages Router API route does not branch on request methods, so it accepts every HTTP method.

### missing-auth-check

**Mutating handler without auth check** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route handler has no recognizable authentication check, and no middleware applies one globally.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-auth-hook

**Mutating route without auth hook** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route has no recognizable authentication hook (onRequest, preParsing, preValidation, or preHandler) in its route options, in addHook() calls of its plugin or of fastify-plugin plugins sharing that context, or inherited from every place the plugin is registered.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-auth-middleware

**Mutating route without auth middleware** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route has no recognizable authentication or authorization middleware on the route, in earlier pathless router.use() calls, or on every mount that reaches its router.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-dto

**Request body without typed DTO** · default severity: `warning`

A POST, PUT, or PATCH endpoint's @Body() type is not a class (for example any, Record<...>, Partial<...>, an inline type, or an interface), so ValidationPipe cannot validate the request body.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-error-handler

**No custom error handler** · default severity: `warning`

No setErrorHandler() call was found, so Fastify's default handler replies with the message of every error, including unexpected 500 errors.

- CWE: [CWE-209](https://cwe.mitre.org/data/definitions/209.html)

### missing-error-middleware

**No centralized error middleware** · default severity: `warning`

No four-argument Express error handler is registered, so unhandled errors fall back to Express defaults and may leak details.

- CWE: [CWE-209](https://cwe.mitre.org/data/definitions/209.html)

### missing-guard

**Mutating endpoint without auth guard** · default severity: `warning`

A POST, PUT, PATCH, or DELETE endpoint has no guard on the method or its controller (including custom decorators built on UseGuards), no global guard from useGlobalGuards() or APP_GUARD applies, and it is not marked public, so it may be reachable without authentication.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-health-endpoint

**No health endpoint** · default severity: `info`

No health, readiness, or liveness route was detected for runtime monitoring and orchestration probes.

### missing-hono-auth-middleware

**Mutating Hono route without auth middleware** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route has no recognizable authentication middleware (such as jwt(), bearerAuth(), basicAuth(), or a createRoute() middleware) in its own handlers or in an app.use() whose path matches the route and that is registered before it on the same app or on every app that mounts it with app.route(). Hono runs middleware in registration order, so app.use() after the route does not protect it.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-hono-error-handler

**No Hono error handler** · default severity: `info`

No app.onError() handler was found. Hono's default handler logs the error and replies with a plain-text 500, so clients get a response that does not match the API's error format and errors reach no logger or error tracker beyond the console.

### missing-hono-validator

**Hono route without body validator** · default severity: `warning`

A POST, PUT, or PATCH route has no validator for the json or form target (zValidator, vValidator, tbValidator, sValidator, arktypeValidator, or validator() from hono/validator) and no @hono/zod-openapi request body, so the handler reads an unvalidated request body. Validators for param, query, header, or cookie do not count.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-react-router-auth

**React Router action without auth check** · default severity: `warning`

A route module's action, which handles POST, PUT, PATCH, and DELETE requests to its URL, does not reject anonymous requests: it calls no auth check such as requireUserId(request), requireUser(), authenticator.isAuthenticated(request, { failureRedirect }), or a webhook signature check (Stripe constructEvent(), Svix verify()), reads no user from context.get(userContext), does not throw or return a redirect or a 401 or 403 response when the session, user, or a credential such as the Authorization header is missing or wrong (also in project functions it calls, up to two calls deep), and no middleware export of the route or a parent route rejects anonymous requests. clientMiddleware runs in the browser and protects nothing on the server. Actions of sign-in, sign-up, sign-out, and password recovery routes, and actions that create or destroy the user's session, are not reported. clientAction runs in the browser and is not checked. Findings where the request is passed to code this scan cannot follow have medium confidence.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-react-router-validation

**React Router action without input validation** · default severity: `warning`

An action reads request.formData() or request.json() and nothing checks the submission: no schema parse (Zod parse or safeParse, zod-form-data, Conform parseWithZod, remix-validated-form validate, Valibot, Yup, or a project function that calls one), no typeof or instanceof check, and no comparison of a form value with a literal, such as an intent. remix-hook-form's getValidatedFormData(request, resolver) reads and validates the body itself.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-request-validation

**Handler without request validation** · default severity: `warning`

A POST, PUT, or PATCH route handler has no recognizable schema validation of its input.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-return-type

**Endpoint without explicit return type** · default severity: `info`

The handler relies on an inferred return type, which makes accidental response shape changes harder to notice.

### missing-route-schema

**Route without body schema** · default severity: `warning`

A POST, PUT, or PATCH route declares no schema.body (JSON Schema, TypeBox, or a Zod type provider schema) and no recognizable validation hook, so Fastify does not validate the request body.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-swagger

**Endpoint without OpenAPI documentation** · default severity: `info`

The endpoint and its controller have no @nestjs/swagger decorators, so it is missing from generated API documentation.

### missing-trpc-auth-middleware

**tRPC mutation without auth middleware** · default severity: `warning`

A tRPC mutation is built on a procedure whose .use() middleware chain has no recognizable authentication: no middleware throws a TRPCError with code UNAUTHORIZED or FORBIDDEN, throws when ctx.session, ctx.user, or ctx.auth is missing, or is named like an auth check. Builders are followed through variables and imports to t.procedure, so a builder named protectedProcedure is judged by its middleware, and a .use() whose result is discarded protects nothing, because builders are immutable. Queries and subscriptions are not reported. Findings about builders or middleware imported from packages rely on names and have low confidence.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-validation-middleware

**Route without validation middleware** · default severity: `warning`

A POST, PUT, or PATCH route has no recognizable request validation middleware.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### no-controllers

**No NestJS controllers** · default severity: `critical`

The project depends on NestJS but no *.controller.ts files were found, so no HTTP endpoints can be analyzed.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-endpoints

**Controllers without endpoints** · default severity: `warning`

Controller classes exist but none of their methods use an HTTP method decorator such as @Get() or @Post().

### no-express-routes

**No Express routes** · default severity: `critical`

The project depends on Express but no app or router route registrations with a literal path were detected.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-fastify-routes

**No Fastify routes** · default severity: `critical`

The project depends on Fastify but no route registrations with a literal path were detected.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-hono-routes

**No Hono routes** · default severity: `critical`

The project depends on Hono but no route registrations with a literal path were detected.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-nextjs-handlers

**API route files without handlers** · default severity: `critical`

Next.js API route files exist but export no detectable HTTP method handlers.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-react-router-routes

**No React Router route modules** · default severity: `critical`

The project depends on React Router framework mode or Remix, but no route modules were found: no root route in the app directory, no app/routes.ts, and no files in the app/routes directory. A route config whose entries cannot be read statically (for example one built by remix-flat-routes) leaves API Health not applicable instead.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### react-router-loader-auth-only

**Auth check only in a loader** · default severity: `warning`

An action or loader has no auth check of its own and no middleware protects it, but the loader of a parent route (for an action, also of its own route) rejects anonymous requests. That check does not protect it: loaders run in parallel and each can be requested on its own, and a form submission runs the action before any loader. Loaders that return only constants or redirects are not reported, and loader findings have medium confidence because their data may be meant to be public.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### trpc-stack-trace-exposed

**tRPC errors expose stack traces** · default severity: `warning`

The initTRPC instance is created with isDev: true, or with an errorFormatter that returns error.stack outside a condition, so error responses carry server stack traces in production. Without them, tRPC adds the stack only when NODE_ENV is not production.

- CWE: [CWE-209](https://cwe.mitre.org/data/definitions/209.html)
- OWASP Top 10: A05:2021

### unvalidated-trpc-input

**tRPC input without validation** · default severity: `warning`

A tRPC procedure's .input() parser accepts every value: z.any(), z.unknown(), or z.custom() without a check (also when optional, nullable, or defaulted), Valibot's any() or unknown(), or a parser function that only returns its argument, such as (value) => value as Input. The resolver's input is typed but never checked.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

## Security

### committed-env-secret

**Secret in a committed .env file** · default severity: `critical`

A .env file tracked by Git contains a provider token or a long, high-entropy value for a secret-like key. Ignoring the file afterwards does not remove it from history: rotate the secret, then untrack the file with `git rm --cached`.

- CWE: [CWE-538](https://cwe.mitre.org/data/definitions/538.html), [CWE-798](https://cwe.mitre.org/data/definitions/798.html)
- OWASP Top 10: A05:2021

### dynamic-command-execution

**Dynamic shell command** · default severity: `warning`

A shell is invoked through exec or execSync, or through spawn, spawnSync, execFile, or execFileSync with a `shell` option, with a non-literal command or argument. The finding is critical when the command comes from request data, directly, through up to three variable assignments, or through project helper functions up to two calls deep, such as a route passing `req.body.cmd` to `run(cmd)`; findings that depend on such a call have medium confidence.

- CWE: [CWE-78](https://cwe.mitre.org/data/definitions/78.html)
- OWASP Top 10: A03:2021

### dynamic-sql-query

**Dynamically built SQL query** · default severity: `warning`

A raw SQL execution method receives a non-literal query. The finding is critical when the query is built from request data, directly, through up to three variable assignments, or through project helper functions up to two calls deep (medium confidence); queries built from request data are reported for any client variable name.

- CWE: [CWE-89](https://cwe.mitre.org/data/definitions/89.html)
- OWASP Top 10: A03:2021

### env-not-gitignored

**.env is not ignored** · default severity: `critical`

The nearest .gitignore does not ignore .env files, so environment secrets can be committed.

- CWE: [CWE-538](https://cwe.mitre.org/data/definitions/538.html)
- OWASP Top 10: A05:2021

### hardcoded-secret

**Hardcoded secret** · default severity: `critical`

Source code or a configuration file (JSON, YAML, TOML, INI, XML, properties, Dockerfile, or .npmrc) contains a value that matches a credential pattern such as an API key, password, or provider token. In configuration files, keys such as `password` or `clientSecret` are reported only for long, high-entropy values that are not placeholders or environment variable references. Findings never include the value itself.

- CWE: [CWE-798](https://cwe.mitre.org/data/definitions/798.html)
- OWASP Top 10: A07:2021

### insecure-cookie

**Session cookie without httpOnly or secure** · default severity: `warning`

A cookie whose name suggests a session or token (session, sid, token, jwt, auth) is set with res.cookie(), reply.setCookie(), or cookies().set() without `httpOnly: true` and `secure: true`, or session middleware (express-session, cookie-session, @fastify/session) sets `httpOnly: false` or `secure: false`. Scripts can then read the cookie, or it is sent over plain HTTP. Non-literal values such as `secure: isProduction` count as set.

- CWE: [CWE-1004](https://cwe.mitre.org/data/definitions/1004.html), [CWE-614](https://cwe.mitre.org/data/definitions/614.html)
- OWASP Top 10: A05:2021

### jwt-expiration-ignored

**JWT expiration ignored** · default severity: `warning`

JWT verification sets `ignoreExpiration: true` (jsonwebtoken, passport-jwt, @nestjs/jwt), so a stolen token stays valid forever.

- CWE: [CWE-613](https://cwe.mitre.org/data/definitions/613.html)
- OWASP Top 10: A07:2021

### jwt-none-algorithm

**JWT accepts the none algorithm** · default severity: `critical`

JWT options list `none` in `algorithms` or set `algorithm: 'none'`, or jose's UnsecuredJWT is used, so tokens without a signature are created or accepted and anyone can forge one.

- CWE: [CWE-347](https://cwe.mitre.org/data/definitions/347.html)
- OWASP Top 10: A02:2021

### no-gitignore

**No .gitignore** · default severity: `critical`

No .gitignore was found in the project or up to three parent directories, so local secrets and build output can be committed.

- CWE: [CWE-538](https://cwe.mitre.org/data/definitions/538.html)
- OWASP Top 10: A05:2021

### no-helmet

**No security headers middleware** · default severity: `warning`

A web server dependency is present but Helmet or the framework's Helmet plugin is never invoked.

- CWE: [CWE-693](https://cwe.mitre.org/data/definitions/693.html)
- OWASP Top 10: A05:2021

### no-rate-limiting

**No rate limiting** · default severity: `warning`

A web server dependency is present but no supported rate limiter is configured.

- CWE: [CWE-770](https://cwe.mitre.org/data/definitions/770.html)
- OWASP Top 10: A04:2021

### open-cors

**CORS without origin allowlist** · default severity: `warning`

CORS is enabled with no options, origin: true, or origin: '*', allowing any website to call the API from a browser.

- CWE: [CWE-942](https://cwe.mitre.org/data/definitions/942.html)
- OWASP Top 10: A05:2021

### open-redirect

**Redirect to a URL from request data** · default severity: `warning`

res.redirect(), reply.redirect(), or NextResponse.redirect() sends users to a target taken from request data, so a link on your domain can forward them to a phishing site. Same-site paths such as `'/orders/' + id` are not reported.

- CWE: [CWE-601](https://cwe.mitre.org/data/definitions/601.html)
- OWASP Top 10: A01:2021

### password-hashing-not-detected

**Password persisted without hashing** · default severity: `warning`

A file handles password data and persists records, but no recognizable password hashing function is used.

- CWE: [CWE-256](https://cwe.mitre.org/data/definitions/256.html)
- OWASP Top 10: A02:2021

### path-traversal

**File path from request data** · default severity: `critical`

A file system call (fs, fs/promises, fs-extra) or res.sendFile()/res.download() without a root option receives a path that comes from request data, so `../` segments can reach files outside the intended directory. Request data is also followed into project helper functions and services up to two calls deep (medium confidence). Values passed through path.basename() or checked with startsWith() in the same function are not reported.

- CWE: [CWE-22](https://cwe.mitre.org/data/definitions/22.html)
- OWASP Top 10: A01:2021

### plaintext-password-comparison

**Direct password comparison** · default severity: `critical`

Password values are compared with an equality operator, which suggests plaintext storage and is not timing-safe.

- CWE: [CWE-256](https://cwe.mitre.org/data/definitions/256.html), [CWE-208](https://cwe.mitre.org/data/definitions/208.html)
- OWASP Top 10: A07:2021

### prototype-pollution

**Prototype pollution** · default severity: `critical`

A nested write such as `target[a][b] = value` uses a key from request data, or a recursive merge copies keys without rejecting `__proto__`, `constructor`, and `prototype`. A key of `__proto__` then changes Object.prototype for the whole process. Nested writes from request data are critical; unguarded recursive merges are warnings. Current versions of lodash and deepmerge guard these keys and are not reported.

- CWE: [CWE-1321](https://cwe.mitre.org/data/definitions/1321.html)
- OWASP Top 10: A08:2021

### reflected-xss

**Request data in an HTML response** · default severity: `critical`

res.send(), res.write(), or res.end(), or a Response with a text/html content type, writes a string that contains request data without HTML escaping. Express serves strings as text/html, so the browser runs any markup in the value. Values passed through an escaping function are not reported.

- CWE: [CWE-79](https://cwe.mitre.org/data/definitions/79.html)
- OWASP Top 10: A03:2021

### secret-history-incomplete

**Git history scan incomplete** · default severity: `info`

The Git history scan for removed secrets stopped at its output size or time limit, so older commits were not checked. The findings it reports cover the commits it read.

### secret-in-git-history

**Secret in Git history** · default severity: `critical`

A commit on the checked-out branch added a credential that is no longer in the current tree, but every clone and fork still contains it. Only scanned with `secretHistory` in .codediag.yml or `--secret-history`: added lines of recent commits are checked for provider formats (private keys, AWS, GitHub, Stripe, Slack, npm, Google, Anthropic, OpenAI, SendGrid, database URLs with a password) and, in configuration and .env files, long random values of secret-like keys. Secrets still in the current tree are left to the other secret rules. Rotate or revoke the credential; rewriting history does not revoke it. Findings never include the value.

- CWE: [CWE-798](https://cwe.mitre.org/data/definitions/798.html), [CWE-312](https://cwe.mitre.org/data/definitions/312.html)
- OWASP Top 10: A07:2021

### server-side-request-forgery

**Outgoing request to a URL from request data** · default severity: `warning`

fetch, axios, got, ky, needle, http(s), superagent, undici, or NestJS HttpService sends a request whose scheme or host comes from request data, so callers can make the server reach internal services. URLs whose origin is fixed before the request data, such as `'https://api.example.com/users/' + id` or `baseUrl + '/users/' + id`, are not reported.

- CWE: [CWE-918](https://cwe.mitre.org/data/definitions/918.html)
- OWASP Top 10: A10:2021

### server-side-template-injection

**Template compiled from request data** · default severity: `critical`

EJS, Pug, Handlebars, Nunjucks, Eta, doT, or lodash compiles or renders a template whose source comes from request data. Template languages can run code on the server, so the caller controls what executes. Passing request data as template variables is not reported.

- CWE: [CWE-1336](https://cwe.mitre.org/data/definitions/1336.html), [CWE-94](https://cwe.mitre.org/data/definitions/94.html)
- OWASP Top 10: A03:2021

### tls-verification-disabled

**TLS verification disabled** · default severity: `critical`

rejectUnauthorized: false or NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification and enables man-in-the-middle attacks.

- CWE: [CWE-295](https://cwe.mitre.org/data/definitions/295.html)
- OWASP Top 10: A07:2021

### unsafe-dynamic-code

**Dynamic code execution** · default severity: `critical`

Runtime code calls eval() or the Function constructor, which executes strings as code.

- CWE: [CWE-95](https://cwe.mitre.org/data/definitions/95.html)
- OWASP Top 10: A03:2021

### weak-password-hash

**Weak password hash** · default severity: `critical`

Code that handles passwords uses MD5 or SHA-1, which are fast general-purpose hashes unsuitable for password storage.

- CWE: [CWE-916](https://cwe.mitre.org/data/definitions/916.html), [CWE-328](https://cwe.mitre.org/data/definitions/328.html)
- OWASP Top 10: A02:2021

## Dependencies

### audit-skipped

**Dependency audit skipped** · default severity: `info`

The package manager audit was turned off with `audit: false` or `--no-audit`, so known vulnerabilities were not checked.

### audit-unavailable

**Dependency audit unavailable** · default severity: `warning`

The package manager audit could not be run or its output could not be parsed, so known vulnerabilities were not checked.

- Root cause: [`lock-file-manager-mismatch`](#lock-file-manager-mismatch)

### deprecated-dep

**Deprecated dependency** · default severity: `warning`

A dependency is a known deprecated or unmaintained package such as request or node-uuid.

- CWE: [CWE-1104](https://cwe.mitre.org/data/definitions/1104.html)
- OWASP Top 10: A06:2021

### invalid-package-json

**Invalid package.json** · default severity: `critical`

package.json is not valid JSON or is not an object.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### lock-file-manager-mismatch

**Lock file does not match packageManager** · default severity: `critical`

The packageManager field selects a different package manager than the lock file that was found.

### missing-scripts

**Missing build or start scripts** · default severity: `warning`

package.json does not define a build script and a start or dev script.

### no-engines

**No Node.js engine range** · default severity: `info`

package.json has no "engines.node" field, so supported Node.js versions are undocumented and unenforced.

### no-lock-file

**No lock file** · default severity: `critical`

No npm, pnpm, or Yarn lock file was found in the project or up to three parent directories, so installs are not reproducible.

### no-package-json

**No package.json** · default severity: `critical`

The scanned directory has no package.json.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### vuln-critical

**Critical dependency vulnerabilities** · default severity: `critical`

The package manager audit reports dependencies with critical severity advisories.

- CWE: [CWE-1395](https://cwe.mitre.org/data/definitions/1395.html)
- OWASP Top 10: A06:2021

### vuln-high

**High severity dependency vulnerabilities** · default severity: `warning`

The package manager audit reports dependencies with high severity advisories.

- CWE: [CWE-1395](https://cwe.mitre.org/data/definitions/1395.html)
- OWASP Top 10: A06:2021

### vuln-low

**Low severity dependency vulnerabilities** · default severity: `info`

The package manager audit reports dependencies with low severity advisories.

- CWE: [CWE-1395](https://cwe.mitre.org/data/definitions/1395.html)
- OWASP Top 10: A06:2021

### vuln-moderate

**Moderate dependency vulnerabilities** · default severity: `warning`

The package manager audit reports dependencies with moderate severity advisories.

- CWE: [CWE-1395](https://cwe.mitre.org/data/definitions/1395.html)
- OWASP Top 10: A06:2021

## Testing

### coverage-below-threshold

**Coverage below threshold** · default severity: `warning`

Measured coverage is below 80% for lines or statements, or below 70% for functions or branches. It is critical when any metric is below 50%.

### invalid-coverage-report

**Unreadable coverage report** · default severity: `warning`

coverage-summary.json exists but does not contain a valid Istanbul total summary.

### low-test-ratio

**Low test-to-source ratio** · default severity: `info`

There is less than one test file per three source files.

### no-coverage-config

**No coverage threshold** · default severity: `info`

No coverage report was found and no coverage threshold is configured.

- Root cause: [`no-test-files`](#no-test-files)

### no-e2e-dir

**No test directory** · default severity: `info`

No test, tests, e2e, or __tests__ directory exists for integration or end-to-end tests.

- Root cause: [`no-test-files`](#no-test-files)

### no-test-config

**No test framework config** · default severity: `info`

A test framework is installed but its configuration file was not found.

### no-test-files

**No test files** · default severity: `critical`

No *.test.* or *.spec.* files were found.

- Scoring: sets the analyzer score to 0 (nothing to evaluate)

### no-test-framework

**No test framework** · default severity: `warning`

No Jest, Vitest, Mocha, Ava, or node:test setup was detected in package.json.

### zero-test-ratio

**No tests relative to source** · default severity: `warning`

Source files exist but there are no test files for them.

- Root cause: [`no-test-files`](#no-test-files)

## Structure

### invalid-tsconfig

**Unresolvable tsconfig.json** · default severity: `warning`

tsconfig.json is invalid JSONC or extends a configuration that cannot be resolved.

### no-editorconfig

**No .editorconfig** · default severity: `info`

No .editorconfig was found in the project or its parent workspace.

### no-env-example

**No environment template** · default severity: `info`

Environment files exist without a shareable .env.example, .env.sample, or .env.template.

### no-formatter

**No formatter config** · default severity: `info`

No Prettier or Biome formatter configuration was found in the project, package.json, or parent workspace.

### no-linter

**No linter config** · default severity: `warning`

No ESLint or Biome configuration was found in the project, package.json, or parent workspace.

### no-nest-module

**No NestJS module** · default severity: `warning`

No *.module.* files were found under src/.

### no-readme

**No README** · default severity: `warning`

The project has no README file.

### no-src-dir

**No src directory** · default severity: `warning`

A NestJS project has no src/ directory.

### no-strict-mode

**TypeScript strict mode disabled** · default severity: `warning`

The resolved TypeScript configuration does not enable "strict".

### no-tsconfig

**No tsconfig.json** · default severity: `warning`

TypeScript is installed but tsconfig.json is missing.

### poor-module-org

**Feature without colocated module** · default severity: `info`

A directory containing NestJS controllers or services has no module in it or in a parent directory below src/.

### short-readme

**README has little content** · default severity: `info`

The README contains fewer than 100 characters of prose after removing badges and markup.

### structure-scan-failed

**Module organization not inspected** · default severity: `warning`

NestJS module organization could not be inspected.

### suppression-missing-reason

**Suppression without reason** · default severity: `info`

A codediag-ignore comment has no rule IDs or no reason after `--`, so it was not applied.

### unused-suppression

**Unused suppression** · default severity: `info`

A codediag-ignore comment matches no finding or names an unknown rule, so it can be removed or corrected.
