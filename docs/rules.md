# CodeDiag rules

<!-- Generated from src/rules/registry.ts by `npm run docs:rules`. Do not edit by hand. -->

Every finding carries one of these rule IDs. SARIF output links each rule
to its section here through `helpUri`.

## API Health

### implicit-pages-methods

**Pages API route without method branches** · default severity: `info`

A Pages Router API route does not branch on request methods, so it accepts every HTTP method.

### missing-auth-check

**Mutating handler without auth check** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route handler has no recognizable authentication check, and no middleware applies one globally.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-auth-middleware

**Mutating route without auth middleware** · default severity: `warning`

A POST, PUT, PATCH, or DELETE route has no recognizable authentication or authorization middleware.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-dto

**Request body without typed DTO** · default severity: `warning`

A POST, PUT, or PATCH endpoint does not declare a typed @Body() parameter, so request input cannot be validated by a DTO class.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-error-middleware

**No centralized error middleware** · default severity: `warning`

No four-argument Express error handler is registered, so unhandled errors fall back to Express defaults and may leak details.

- CWE: [CWE-209](https://cwe.mitre.org/data/definitions/209.html)

### missing-guard

**Mutating endpoint without auth guard** · default severity: `warning`

A POST, PUT, PATCH, or DELETE endpoint has no @UseGuards() on the method or its controller, so it may be reachable without authentication.

- CWE: [CWE-306](https://cwe.mitre.org/data/definitions/306.html)
- OWASP Top 10: A07:2021

### missing-health-endpoint

**No health endpoint** · default severity: `info`

No health, readiness, or liveness route was detected for runtime monitoring and orchestration probes.

### missing-request-validation

**Handler without request validation** · default severity: `warning`

A POST, PUT, or PATCH route handler has no recognizable schema validation of its input.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### missing-return-type

**Endpoint without explicit return type** · default severity: `info`

The handler relies on an inferred return type, which makes accidental response shape changes harder to notice.

### missing-swagger

**Endpoint without OpenAPI documentation** · default severity: `info`

The endpoint and its controller have no @nestjs/swagger decorators, so it is missing from generated API documentation.

### missing-validation-middleware

**Route without validation middleware** · default severity: `warning`

A POST, PUT, or PATCH route has no recognizable request validation middleware.

- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html)
- OWASP Top 10: A03:2021

### no-controllers

**No NestJS controllers** · default severity: `critical`

The project depends on NestJS but no *.controller.ts files were found, so no HTTP endpoints can be analyzed.

### no-endpoints

**Controllers without endpoints** · default severity: `warning`

Controller classes exist but none of their methods use an HTTP method decorator such as @Get() or @Post().

### no-express-routes

**No Express routes** · default severity: `critical`

The project depends on Express but no app or router route registrations with a literal path were detected.

### no-nextjs-handlers

**API route files without handlers** · default severity: `critical`

Next.js API route files exist but export no detectable HTTP method handlers.

## Security

### dynamic-command-execution

**Dynamic shell command** · default severity: `warning`

A shell is invoked through exec or execSync with a non-literal command. The finding is critical when the command visibly includes request data.

- CWE: [CWE-78](https://cwe.mitre.org/data/definitions/78.html)
- OWASP Top 10: A03:2021

### dynamic-sql-query

**Dynamically built SQL query** · default severity: `warning`

A raw SQL execution method receives a non-literal query. The finding is critical when the query visibly includes request data.

- CWE: [CWE-89](https://cwe.mitre.org/data/definitions/89.html)
- OWASP Top 10: A03:2021

### env-not-gitignored

**.env is not ignored** · default severity: `critical`

The nearest .gitignore does not ignore .env files, so environment secrets can be committed.

- CWE: [CWE-538](https://cwe.mitre.org/data/definitions/538.html)
- OWASP Top 10: A05:2021

### hardcoded-secret

**Hardcoded secret** · default severity: `critical`

Source code contains a value that matches a credential pattern such as an API key, password, or provider token.

- CWE: [CWE-798](https://cwe.mitre.org/data/definitions/798.html)
- OWASP Top 10: A07:2021

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

### password-hashing-not-detected

**Password persisted without hashing** · default severity: `warning`

A file handles password data and persists records, but no recognizable password hashing function is used.

- CWE: [CWE-256](https://cwe.mitre.org/data/definitions/256.html)
- OWASP Top 10: A02:2021

### plaintext-password-comparison

**Direct password comparison** · default severity: `critical`

Password values are compared with an equality operator, which suggests plaintext storage and is not timing-safe.

- CWE: [CWE-256](https://cwe.mitre.org/data/definitions/256.html), [CWE-208](https://cwe.mitre.org/data/definitions/208.html)
- OWASP Top 10: A07:2021

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
