import type { DiagnosticIssue } from "../types.js";

export type AnalyzerName =
  | "API Health"
  | "Security"
  | "Dependencies"
  | "Testing"
  | "Structure";

export interface RuleDefinition {
  analyzer: AnalyzerName;
  title: string;
  description: string;
  defaultSeverity: DiagnosticIssue["severity"];
  cwe?: readonly string[];
  owasp?: readonly string[];
  /**
   * The rule whose finding explains this one. When both are reported, this
   * finding is a consequence of the root cause rather than a separate problem.
   */
  rootCause?: string;
  /**
   * The flagged line may contain a credential. Fingerprints must not hash it,
   * because a digest of a guessable line can be brute-forced offline.
   */
  sensitiveSource?: boolean;
  /**
   * The finding means the analyzer had nothing to evaluate, so scoring
   * version 2 sets that analyzer's score to 0.
   */
  failsAnalyzer?: boolean;
  /**
   * Numbers in the message are part of the finding's identity, so a changed
   * count (more vulnerabilities) is a new finding for baselines.
   */
  countsAreIdentity?: boolean;
  /**
   * Findings in a file without a line are told apart by their message (such
   * as the commit it names), so fingerprints include it.
   */
  messageIsIdentity?: boolean;
}

export const RULES_DOCUMENT_URL =
  "https://github.com/sabahattink/codediag/blob/main/docs/rules.md";

const OWASP = {
  accessControl: "A01:2021",
  cryptographic: "A02:2021",
  injection: "A03:2021",
  insecureDesign: "A04:2021",
  misconfiguration: "A05:2021",
  vulnerableComponents: "A06:2021",
  authentication: "A07:2021",
  integrity: "A08:2021",
  requestForgery: "A10:2021",
} as const;

export const RULES = {
  // API Health: NestJS
  "no-controllers": {
    analyzer: "API Health",
    title: "No NestJS controllers",
    description:
      "The project depends on NestJS but no *.controller.ts files were found, so no HTTP endpoints can be analyzed.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "no-endpoints": {
    analyzer: "API Health",
    title: "Controllers without endpoints",
    description:
      "Controller classes exist but none of their methods use an HTTP method decorator such as @Get() or @Post().",
    defaultSeverity: "warning",
  },
  "missing-guard": {
    analyzer: "API Health",
    title: "Mutating endpoint without auth guard",
    description:
      "A POST, PUT, PATCH, or DELETE endpoint has no guard on the method or its controller (including custom decorators built on UseGuards), no global guard from useGlobalGuards() or APP_GUARD applies, and it is not marked public, so it may be reachable without authentication.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-dto": {
    analyzer: "API Health",
    title: "Request body without typed DTO",
    description:
      "A POST, PUT, or PATCH endpoint's @Body() type is not a class (for example any, Record<...>, Partial<...>, an inline type, or an interface), so ValidationPipe cannot validate the request body.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "dto-not-validated": {
    analyzer: "API Health",
    title: "DTOs without ValidationPipe",
    description:
      "Endpoints take DTO classes, but no global, controller, method, or parameter ValidationPipe validates them, so class-validator rules are never enforced.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "missing-swagger": {
    analyzer: "API Health",
    title: "Endpoint without OpenAPI documentation",
    description:
      "The endpoint and its controller have no @nestjs/swagger decorators, so it is missing from generated API documentation.",
    defaultSeverity: "info",
  },
  "missing-return-type": {
    analyzer: "API Health",
    title: "Endpoint without explicit return type",
    description:
      "The handler relies on an inferred return type, which makes accidental response shape changes harder to notice.",
    defaultSeverity: "info",
  },
  // API Health: Express
  "no-express-routes": {
    analyzer: "API Health",
    title: "No Express routes",
    description:
      "The project depends on Express but no app or router route registrations with a literal path were detected.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "missing-auth-middleware": {
    analyzer: "API Health",
    title: "Mutating route without auth middleware",
    description:
      "A POST, PUT, PATCH, or DELETE route has no recognizable authentication or authorization middleware on the route, in earlier pathless router.use() calls, or on every mount that reaches its router.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-validation-middleware": {
    analyzer: "API Health",
    title: "Route without validation middleware",
    description:
      "A POST, PUT, or PATCH route has no recognizable request validation middleware.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "missing-error-middleware": {
    analyzer: "API Health",
    title: "No centralized error middleware",
    description:
      "No four-argument Express error handler is registered, so unhandled errors fall back to Express defaults and may leak details.",
    defaultSeverity: "warning",
    cwe: ["CWE-209"],
  },
  // API Health: Fastify
  "no-fastify-routes": {
    analyzer: "API Health",
    title: "No Fastify routes",
    description:
      "The project depends on Fastify but no route registrations with a literal path were detected.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "missing-auth-hook": {
    analyzer: "API Health",
    title: "Mutating route without auth hook",
    description:
      "A POST, PUT, PATCH, or DELETE route has no recognizable authentication hook (onRequest, preParsing, preValidation, or preHandler) in its route options, in addHook() calls of its plugin or of fastify-plugin plugins sharing that context, or inherited from every place the plugin is registered.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-route-schema": {
    analyzer: "API Health",
    title: "Route without body schema",
    description:
      "A POST, PUT, or PATCH route declares no schema.body (JSON Schema, TypeBox, or a Zod type provider schema) and no recognizable validation hook, so Fastify does not validate the request body.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "missing-error-handler": {
    analyzer: "API Health",
    title: "No custom error handler",
    description:
      "No setErrorHandler() call was found, so Fastify's default handler replies with the message of every error, including unexpected 500 errors.",
    defaultSeverity: "warning",
    cwe: ["CWE-209"],
  },
  // API Health: Hono
  "no-hono-routes": {
    analyzer: "API Health",
    title: "No Hono routes",
    description:
      "The project depends on Hono but no route registrations with a literal path were detected.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "missing-hono-auth-middleware": {
    analyzer: "API Health",
    title: "Mutating Hono route without auth middleware",
    description:
      "A POST, PUT, PATCH, or DELETE route has no recognizable authentication middleware (such as jwt(), bearerAuth(), basicAuth(), or a createRoute() middleware) in its own handlers or in an app.use() whose path matches the route and that is registered before it on the same app or on every app that mounts it with app.route(). Hono runs middleware in registration order, so app.use() after the route does not protect it.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-hono-validator": {
    analyzer: "API Health",
    title: "Hono route without body validator",
    description:
      "A POST, PUT, or PATCH route has no validator for the json or form target (zValidator, vValidator, tbValidator, sValidator, arktypeValidator, or validator() from hono/validator) and no @hono/zod-openapi request body, so the handler reads an unvalidated request body. Validators for param, query, header, or cookie do not count.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "missing-hono-error-handler": {
    analyzer: "API Health",
    title: "No Hono error handler",
    description:
      "No app.onError() handler was found. Hono's default handler logs the error and replies with a plain-text 500, so clients get a response that does not match the API's error format and errors reach no logger or error tracker beyond the console.",
    defaultSeverity: "info",
  },
  // API Health: React Router
  "no-react-router-routes": {
    analyzer: "API Health",
    title: "No React Router route modules",
    description:
      "The project depends on React Router framework mode or Remix, but no route modules were found: no root route in the app directory, no app/routes.ts, and no files in the app/routes directory. A route config whose entries cannot be read statically (for example one built by remix-flat-routes) leaves API Health not applicable instead.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "missing-react-router-auth": {
    analyzer: "API Health",
    title: "React Router action without auth check",
    description:
      "A route module's action, which handles POST, PUT, PATCH, and DELETE requests to its URL, does not reject anonymous requests: it calls no auth check such as requireUserId(request), requireUser(), authenticator.isAuthenticated(request, { failureRedirect }), or a webhook signature check (Stripe constructEvent(), Svix verify()), reads no user from context.get(userContext), does not throw or return a redirect or a 401 or 403 response when the session, user, or a credential such as the Authorization header is missing or wrong (also in project functions it calls, up to two calls deep), and no middleware export of the route or a parent route rejects anonymous requests. clientMiddleware runs in the browser and protects nothing on the server. Actions of sign-in, sign-up, sign-out, and password recovery routes, and actions that create or destroy the user's session, are not reported. clientAction runs in the browser and is not checked. Findings where the request is passed to code this scan cannot follow have medium confidence.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "react-router-loader-auth-only": {
    analyzer: "API Health",
    title: "Auth check only in a loader",
    description:
      "An action or loader has no auth check of its own and no middleware protects it, but the loader of a parent route (for an action, also of its own route) rejects anonymous requests. That check does not protect it: loaders run in parallel and each can be requested on its own, and a form submission runs the action before any loader. Loaders that return only constants or redirects are not reported, and loader findings have medium confidence because their data may be meant to be public.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-react-router-validation": {
    analyzer: "API Health",
    title: "React Router action without input validation",
    description:
      "An action reads request.formData() or request.json() and nothing checks the submission: no schema parse (Zod parse or safeParse, zod-form-data, Conform parseWithZod, remix-validated-form validate, Valibot, Yup, or a project function that calls one), no typeof or instanceof check, and no comparison of a form value with a literal, such as an intent. remix-hook-form's getValidatedFormData(request, resolver) reads and validates the body itself.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  // API Health: tRPC
  "missing-trpc-auth-middleware": {
    analyzer: "API Health",
    title: "tRPC mutation without auth middleware",
    description:
      "A tRPC mutation is built on a procedure whose .use() middleware chain has no recognizable authentication: no middleware throws a TRPCError with code UNAUTHORIZED or FORBIDDEN, throws when ctx.session, ctx.user, or ctx.auth is missing, or is named like an auth check. Builders are followed through variables and imports to t.procedure, so a builder named protectedProcedure is judged by its middleware, and a .use() whose result is discarded protects nothing, because builders are immutable. Queries and subscriptions are not reported. Findings about builders or middleware imported from packages rely on names and have low confidence.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "unvalidated-trpc-input": {
    analyzer: "API Health",
    title: "tRPC input without validation",
    description:
      "A tRPC procedure's .input() parser accepts every value: z.any(), z.unknown(), or z.custom() without a check (also when optional, nullable, or defaulted), Valibot's any() or unknown(), or a parser function that only returns its argument, such as (value) => value as Input. The resolver's input is typed but never checked.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "trpc-stack-trace-exposed": {
    analyzer: "API Health",
    title: "tRPC errors expose stack traces",
    description:
      "The initTRPC instance is created with isDev: true, or with an errorFormatter that returns error.stack outside a condition, so error responses carry server stack traces in production. Without them, tRPC adds the stack only when NODE_ENV is not production.",
    defaultSeverity: "warning",
    cwe: ["CWE-209"],
    owasp: [OWASP.misconfiguration],
  },
  // API Health: Next.js
  "no-nextjs-handlers": {
    analyzer: "API Health",
    title: "API route files without handlers",
    description:
      "Next.js API route files exist but export no detectable HTTP method handlers.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "missing-auth-check": {
    analyzer: "API Health",
    title: "Mutating handler without auth check",
    description:
      "A POST, PUT, PATCH, or DELETE route handler has no recognizable authentication check, and no middleware applies one globally.",
    defaultSeverity: "warning",
    cwe: ["CWE-306"],
    owasp: [OWASP.authentication],
  },
  "missing-request-validation": {
    analyzer: "API Health",
    title: "Handler without request validation",
    description:
      "A POST, PUT, or PATCH route handler has no recognizable schema validation of its input.",
    defaultSeverity: "warning",
    cwe: ["CWE-20"],
    owasp: [OWASP.injection],
  },
  "implicit-pages-methods": {
    analyzer: "API Health",
    title: "Pages API route without method branches",
    description:
      "A Pages Router API route does not branch on request methods, so it accepts every HTTP method.",
    defaultSeverity: "info",
  },
  // API Health: shared
  "missing-health-endpoint": {
    analyzer: "API Health",
    title: "No health endpoint",
    description:
      "No health, readiness, or liveness route was detected for runtime monitoring and orchestration probes.",
    defaultSeverity: "info",
  },

  // Security
  "no-gitignore": {
    analyzer: "Security",
    title: "No .gitignore",
    description:
      "No .gitignore was found in the project or up to three parent directories, so local secrets and build output can be committed.",
    defaultSeverity: "critical",
    cwe: ["CWE-538"],
    owasp: [OWASP.misconfiguration],
  },
  "env-not-gitignored": {
    analyzer: "Security",
    title: ".env is not ignored",
    description:
      "The nearest .gitignore does not ignore .env files, so environment secrets can be committed.",
    defaultSeverity: "critical",
    cwe: ["CWE-538"],
    owasp: [OWASP.misconfiguration],
  },
  "hardcoded-secret": {
    analyzer: "Security",
    title: "Hardcoded secret",
    description:
      "Source code or a configuration file (JSON, YAML, TOML, INI, XML, properties, Dockerfile, or .npmrc) contains a value that matches a credential pattern such as an API key, password, or provider token. In configuration files, keys such as `password` or `clientSecret` are reported only for long, high-entropy values that are not placeholders or environment variable references. Findings never include the value itself.",
    defaultSeverity: "critical",
    cwe: ["CWE-798"],
    owasp: [OWASP.authentication],
    sensitiveSource: true,
  },
  "committed-env-secret": {
    analyzer: "Security",
    title: "Secret in a committed .env file",
    description:
      "A .env file tracked by Git contains a provider token or a long, high-entropy value for a secret-like key. Ignoring the file afterwards does not remove it from history: rotate the secret, then untrack the file with `git rm --cached`.",
    defaultSeverity: "critical",
    cwe: ["CWE-538", "CWE-798"],
    owasp: [OWASP.misconfiguration],
    sensitiveSource: true,
  },
  "secret-in-git-history": {
    analyzer: "Security",
    title: "Secret in Git history",
    description:
      "A commit on the checked-out branch added a credential that is no longer in the current tree, but every clone and fork still contains it. Only scanned with `secretHistory` in .codediag.yml or `--secret-history`: added lines of recent commits are checked for provider formats (private keys, AWS, GitHub, Stripe, Slack, npm, Google, Anthropic, OpenAI, SendGrid, database URLs with a password) and, in configuration and .env files, long random values of secret-like keys. Secrets still in the current tree are left to the other secret rules. Rotate or revoke the credential; rewriting history does not revoke it. Findings never include the value.",
    defaultSeverity: "critical",
    cwe: ["CWE-798", "CWE-312"],
    owasp: [OWASP.authentication],
    messageIsIdentity: true,
  },
  "secret-history-incomplete": {
    analyzer: "Security",
    title: "Git history scan incomplete",
    description:
      "The Git history scan for removed secrets stopped at its output size or time limit, so older commits were not checked. The findings it reports cover the commits it read.",
    defaultSeverity: "info",
  },
  "weak-password-hash": {
    analyzer: "Security",
    title: "Weak password hash",
    description:
      "Code that handles passwords uses MD5 or SHA-1, which are fast general-purpose hashes unsuitable for password storage.",
    defaultSeverity: "critical",
    cwe: ["CWE-916", "CWE-328"],
    owasp: [OWASP.cryptographic],
  },
  "plaintext-password-comparison": {
    analyzer: "Security",
    title: "Direct password comparison",
    description:
      "Password values are compared with an equality operator, which suggests plaintext storage and is not timing-safe.",
    defaultSeverity: "critical",
    cwe: ["CWE-256", "CWE-208"],
    owasp: [OWASP.authentication],
  },
  "password-hashing-not-detected": {
    analyzer: "Security",
    title: "Password persisted without hashing",
    description:
      "A file handles password data and persists records, but no recognizable password hashing function is used.",
    defaultSeverity: "warning",
    cwe: ["CWE-256"],
    owasp: [OWASP.cryptographic],
  },
  "unsafe-dynamic-code": {
    analyzer: "Security",
    title: "Dynamic code execution",
    description:
      "Runtime code calls eval() or the Function constructor, which executes strings as code.",
    defaultSeverity: "critical",
    cwe: ["CWE-95"],
    owasp: [OWASP.injection],
  },
  "dynamic-command-execution": {
    analyzer: "Security",
    title: "Dynamic shell command",
    description:
      "A shell is invoked through exec or execSync, or through spawn, spawnSync, execFile, or execFileSync with a `shell` option, with a non-literal command or argument. The finding is critical when the command comes from request data, directly, through up to three variable assignments, or through project helper functions up to two calls deep, such as a route passing `req.body.cmd` to `run(cmd)`; findings that depend on such a call have medium confidence.",
    defaultSeverity: "warning",
    cwe: ["CWE-78"],
    owasp: [OWASP.injection],
  },
  "path-traversal": {
    analyzer: "Security",
    title: "File path from request data",
    description:
      "A file system call (fs, fs/promises, fs-extra) or res.sendFile()/res.download() without a root option receives a path that comes from request data, so `../` segments can reach files outside the intended directory. Request data is also followed into project helper functions and services up to two calls deep (medium confidence). Values passed through path.basename() or checked with startsWith() in the same function are not reported.",
    defaultSeverity: "critical",
    cwe: ["CWE-22"],
    owasp: [OWASP.accessControl],
  },
  "server-side-request-forgery": {
    analyzer: "Security",
    title: "Outgoing request to a URL from request data",
    description:
      "fetch, axios, got, ky, needle, http(s), superagent, undici, or NestJS HttpService sends a request whose scheme or host comes from request data, so callers can make the server reach internal services. URLs whose origin is fixed before the request data, such as `'https://api.example.com/users/' + id` or `baseUrl + '/users/' + id`, are not reported.",
    defaultSeverity: "warning",
    cwe: ["CWE-918"],
    owasp: [OWASP.requestForgery],
  },
  "open-redirect": {
    analyzer: "Security",
    title: "Redirect to a URL from request data",
    description:
      "res.redirect(), reply.redirect(), or NextResponse.redirect() sends users to a target taken from request data, so a link on your domain can forward them to a phishing site. Same-site paths such as `'/orders/' + id` are not reported.",
    defaultSeverity: "warning",
    cwe: ["CWE-601"],
    owasp: [OWASP.accessControl],
  },
  "reflected-xss": {
    analyzer: "Security",
    title: "Request data in an HTML response",
    description:
      "res.send(), res.write(), or res.end(), or a Response with a text/html content type, writes a string that contains request data without HTML escaping. Express serves strings as text/html, so the browser runs any markup in the value. Values passed through an escaping function are not reported.",
    defaultSeverity: "critical",
    cwe: ["CWE-79"],
    owasp: [OWASP.injection],
  },
  "server-side-template-injection": {
    analyzer: "Security",
    title: "Template compiled from request data",
    description:
      "EJS, Pug, Handlebars, Nunjucks, Eta, doT, or lodash compiles or renders a template whose source comes from request data. Template languages can run code on the server, so the caller controls what executes. Passing request data as template variables is not reported.",
    defaultSeverity: "critical",
    cwe: ["CWE-1336", "CWE-94"],
    owasp: [OWASP.injection],
  },
  "prototype-pollution": {
    analyzer: "Security",
    title: "Prototype pollution",
    description:
      "A nested write such as `target[a][b] = value` uses a key from request data, or a recursive merge copies keys without rejecting `__proto__`, `constructor`, and `prototype`. A key of `__proto__` then changes Object.prototype for the whole process. Nested writes from request data are critical; unguarded recursive merges are warnings. Current versions of lodash and deepmerge guard these keys and are not reported.",
    defaultSeverity: "critical",
    cwe: ["CWE-1321"],
    owasp: [OWASP.integrity],
  },
  "dynamic-sql-query": {
    analyzer: "Security",
    title: "Dynamically built SQL query",
    description:
      "A raw SQL execution method receives a non-literal query. The finding is critical when the query is built from request data, directly, through up to three variable assignments, or through project helper functions up to two calls deep (medium confidence); queries built from request data are reported for any client variable name.",
    defaultSeverity: "warning",
    cwe: ["CWE-89"],
    owasp: [OWASP.injection],
  },
  "tls-verification-disabled": {
    analyzer: "Security",
    title: "TLS verification disabled",
    description:
      "rejectUnauthorized: false or NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification and enables man-in-the-middle attacks.",
    defaultSeverity: "critical",
    cwe: ["CWE-295"],
    owasp: [OWASP.authentication],
  },
  "jwt-none-algorithm": {
    analyzer: "Security",
    title: "JWT accepts the none algorithm",
    description:
      "JWT options list `none` in `algorithms` or set `algorithm: 'none'`, or jose's UnsecuredJWT is used, so tokens without a signature are created or accepted and anyone can forge one.",
    defaultSeverity: "critical",
    cwe: ["CWE-347"],
    owasp: [OWASP.cryptographic],
  },
  "jwt-expiration-ignored": {
    analyzer: "Security",
    title: "JWT expiration ignored",
    description:
      "JWT verification sets `ignoreExpiration: true` (jsonwebtoken, passport-jwt, @nestjs/jwt), so a stolen token stays valid forever.",
    defaultSeverity: "warning",
    cwe: ["CWE-613"],
    owasp: [OWASP.authentication],
  },
  "insecure-cookie": {
    analyzer: "Security",
    title: "Session cookie without httpOnly or secure",
    description:
      "A cookie whose name suggests a session or token (session, sid, token, jwt, auth) is set with res.cookie(), reply.setCookie(), or cookies().set() without `httpOnly: true` and `secure: true`, or session middleware (express-session, cookie-session, @fastify/session) sets `httpOnly: false` or `secure: false`. Scripts can then read the cookie, or it is sent over plain HTTP. Non-literal values such as `secure: isProduction` count as set.",
    defaultSeverity: "warning",
    cwe: ["CWE-1004", "CWE-614"],
    owasp: [OWASP.misconfiguration],
  },
  "no-helmet": {
    analyzer: "Security",
    title: "No security headers middleware",
    description:
      "A web server dependency is present but Helmet or the framework's Helmet plugin is never invoked.",
    defaultSeverity: "warning",
    cwe: ["CWE-693"],
    owasp: [OWASP.misconfiguration],
  },
  "open-cors": {
    analyzer: "Security",
    title: "CORS without origin allowlist",
    description:
      "CORS is enabled with no options, origin: true, or origin: '*', allowing any website to call the API from a browser.",
    defaultSeverity: "warning",
    cwe: ["CWE-942"],
    owasp: [OWASP.misconfiguration],
  },
  "no-rate-limiting": {
    analyzer: "Security",
    title: "No rate limiting",
    description:
      "A web server dependency is present but no supported rate limiter is configured.",
    defaultSeverity: "warning",
    cwe: ["CWE-770"],
    owasp: [OWASP.insecureDesign],
  },

  // Dependencies
  "no-package-json": {
    analyzer: "Dependencies",
    title: "No package.json",
    description: "The scanned directory has no package.json.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "invalid-package-json": {
    analyzer: "Dependencies",
    title: "Invalid package.json",
    description: "package.json is not valid JSON or is not an object.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "no-lock-file": {
    analyzer: "Dependencies",
    title: "No lock file",
    description:
      "No npm, pnpm, or Yarn lock file was found in the project or up to three parent directories, so installs are not reproducible.",
    defaultSeverity: "critical",
  },
  "lock-file-manager-mismatch": {
    analyzer: "Dependencies",
    title: "Lock file does not match packageManager",
    description:
      "The packageManager field selects a different package manager than the lock file that was found.",
    defaultSeverity: "critical",
  },
  "audit-unavailable": {
    analyzer: "Dependencies",
    title: "Dependency audit unavailable",
    description:
      "The package manager audit could not be run or its output could not be parsed, so known vulnerabilities were not checked.",
    defaultSeverity: "warning",
    rootCause: "lock-file-manager-mismatch",
  },
  "audit-skipped": {
    analyzer: "Dependencies",
    title: "Dependency audit skipped",
    description:
      "The package manager audit was turned off with `audit: false` or `--no-audit`, so known vulnerabilities were not checked.",
    defaultSeverity: "info",
  },
  "vuln-critical": {
    analyzer: "Dependencies",
    title: "Critical dependency vulnerabilities",
    description:
      "The package manager audit reports dependencies with critical severity advisories.",
    defaultSeverity: "critical",
    cwe: ["CWE-1395"],
    owasp: [OWASP.vulnerableComponents],
    countsAreIdentity: true,
  },
  "vuln-high": {
    analyzer: "Dependencies",
    title: "High severity dependency vulnerabilities",
    description:
      "The package manager audit reports dependencies with high severity advisories.",
    defaultSeverity: "warning",
    cwe: ["CWE-1395"],
    owasp: [OWASP.vulnerableComponents],
    countsAreIdentity: true,
  },
  "vuln-moderate": {
    analyzer: "Dependencies",
    title: "Moderate dependency vulnerabilities",
    description:
      "The package manager audit reports dependencies with moderate severity advisories.",
    defaultSeverity: "warning",
    cwe: ["CWE-1395"],
    owasp: [OWASP.vulnerableComponents],
    countsAreIdentity: true,
  },
  "vuln-low": {
    analyzer: "Dependencies",
    title: "Low severity dependency vulnerabilities",
    description:
      "The package manager audit reports dependencies with low severity advisories.",
    defaultSeverity: "info",
    cwe: ["CWE-1395"],
    owasp: [OWASP.vulnerableComponents],
    countsAreIdentity: true,
  },
  "no-engines": {
    analyzer: "Dependencies",
    title: "No Node.js engine range",
    description:
      'package.json has no "engines.node" field, so supported Node.js versions are undocumented and unenforced.',
    defaultSeverity: "info",
  },
  "missing-scripts": {
    analyzer: "Dependencies",
    title: "Missing build or start scripts",
    description:
      "package.json does not define a build script and a start or dev script.",
    defaultSeverity: "warning",
  },
  "deprecated-dep": {
    analyzer: "Dependencies",
    title: "Deprecated dependency",
    description:
      "A dependency is a known deprecated or unmaintained package such as request or node-uuid.",
    defaultSeverity: "warning",
    cwe: ["CWE-1104"],
    owasp: [OWASP.vulnerableComponents],
  },

  // Testing
  "no-test-files": {
    analyzer: "Testing",
    title: "No test files",
    description: "No *.test.* or *.spec.* files were found.",
    defaultSeverity: "critical",
    failsAnalyzer: true,
  },
  "no-test-framework": {
    analyzer: "Testing",
    title: "No test framework",
    description:
      "No Jest, Vitest, Mocha, Ava, or node:test setup was detected in package.json.",
    defaultSeverity: "warning",
  },
  "zero-test-ratio": {
    analyzer: "Testing",
    title: "No tests relative to source",
    description: "Source files exist but there are no test files for them.",
    defaultSeverity: "warning",
    rootCause: "no-test-files",
  },
  "low-test-ratio": {
    analyzer: "Testing",
    title: "Low test-to-source ratio",
    description: "There is less than one test file per three source files.",
    defaultSeverity: "info",
  },
  "no-e2e-dir": {
    analyzer: "Testing",
    title: "No test directory",
    description:
      "No test, tests, e2e, or __tests__ directory exists for integration or end-to-end tests.",
    defaultSeverity: "info",
    rootCause: "no-test-files",
  },
  "no-test-config": {
    analyzer: "Testing",
    title: "No test framework config",
    description:
      "A test framework is installed but its configuration file was not found.",
    defaultSeverity: "info",
  },
  "no-coverage-config": {
    analyzer: "Testing",
    title: "No coverage threshold",
    description:
      "No coverage report was found and no coverage threshold is configured.",
    defaultSeverity: "info",
    rootCause: "no-test-files",
  },
  "invalid-coverage-report": {
    analyzer: "Testing",
    title: "Unreadable coverage report",
    description:
      "coverage-summary.json exists but does not contain a valid Istanbul total summary.",
    defaultSeverity: "warning",
  },
  "coverage-below-threshold": {
    analyzer: "Testing",
    title: "Coverage below threshold",
    description:
      "Measured coverage is below 80% for lines or statements, or below 70% for functions or branches. It is critical when any metric is below 50%.",
    defaultSeverity: "warning",
  },

  // Structure
  "no-readme": {
    analyzer: "Structure",
    title: "No README",
    description: "The project has no README file.",
    defaultSeverity: "warning",
  },
  "short-readme": {
    analyzer: "Structure",
    title: "README has little content",
    description:
      "The README contains fewer than 100 characters of prose after removing badges and markup.",
    defaultSeverity: "info",
  },
  "no-editorconfig": {
    analyzer: "Structure",
    title: "No .editorconfig",
    description:
      "No .editorconfig was found in the project or its parent workspace.",
    defaultSeverity: "info",
  },
  "no-linter": {
    analyzer: "Structure",
    title: "No linter config",
    description:
      "No ESLint or Biome configuration was found in the project, package.json, or parent workspace.",
    defaultSeverity: "warning",
  },
  "no-formatter": {
    analyzer: "Structure",
    title: "No formatter config",
    description:
      "No Prettier or Biome formatter configuration was found in the project, package.json, or parent workspace.",
    defaultSeverity: "info",
  },
  "no-tsconfig": {
    analyzer: "Structure",
    title: "No tsconfig.json",
    description: "TypeScript is installed but tsconfig.json is missing.",
    defaultSeverity: "warning",
  },
  "invalid-tsconfig": {
    analyzer: "Structure",
    title: "Unresolvable tsconfig.json",
    description:
      "tsconfig.json is invalid JSONC or extends a configuration that cannot be resolved.",
    defaultSeverity: "warning",
  },
  "no-strict-mode": {
    analyzer: "Structure",
    title: "TypeScript strict mode disabled",
    description:
      'The resolved TypeScript configuration does not enable "strict".',
    defaultSeverity: "warning",
  },
  "no-src-dir": {
    analyzer: "Structure",
    title: "No src directory",
    description: "A NestJS project has no src/ directory.",
    defaultSeverity: "warning",
  },
  "no-nest-module": {
    analyzer: "Structure",
    title: "No NestJS module",
    description: "No *.module.* files were found under src/.",
    defaultSeverity: "warning",
  },
  "poor-module-org": {
    analyzer: "Structure",
    title: "Feature without colocated module",
    description:
      "A directory containing NestJS controllers or services has no module in it or in a parent directory below src/.",
    defaultSeverity: "info",
  },
  "structure-scan-failed": {
    analyzer: "Structure",
    title: "Module organization not inspected",
    description: "NestJS module organization could not be inspected.",
    defaultSeverity: "warning",
  },
  "no-env-example": {
    analyzer: "Structure",
    title: "No environment template",
    description:
      "Environment files exist without a shareable .env.example, .env.sample, or .env.template.",
    defaultSeverity: "info",
  },
  "suppression-missing-reason": {
    analyzer: "Structure",
    title: "Suppression without reason",
    description:
      "A codediag-ignore comment has no rule IDs or no reason after `--`, so it was not applied.",
    defaultSeverity: "info",
  },
  "unused-suppression": {
    analyzer: "Structure",
    title: "Unused suppression",
    description:
      "A codediag-ignore comment matches no finding or names an unknown rule, so it can be removed or corrected.",
    defaultSeverity: "info",
  },
} as const satisfies Record<string, RuleDefinition>;

export type RuleId = keyof typeof RULES;

export function getRule(id: string): RuleDefinition | undefined {
  return Object.hasOwn(RULES, id) ? RULES[id as RuleId] : undefined;
}

export function ruleDocsUrl(id: string): string {
  return `${RULES_DOCUMENT_URL}#${id}`;
}

/** The rule id and default severity for a finding; spread into an issue. */
export function fromRule(
  id: RuleId,
): Pick<DiagnosticIssue, "severity" | "rule"> {
  return { severity: RULES[id].defaultSeverity, rule: id };
}
