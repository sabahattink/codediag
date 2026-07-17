# Security analysis

CodeDiag combines source scanning with framework-aware checks. The security
analyzer is designed to catch high-signal mistakes during local development and
CI without requiring a service or a vulnerability database.

## Checks

The analyzer currently reports:

- hardcoded API keys, tokens, and credentials in live source code;
- missing `.env` protection in `.gitignore`;
- missing runtime Helmet and rate-limit middleware in supported web servers;
- open CORS configuration;
- weak password hashing, direct plaintext comparison, and likely unhashed
  password persistence;
- `eval()` and the `Function` constructor;
- non-literal commands passed to imported `child_process.exec()` or
  `execSync()` bindings;
- dynamic SQL passed to common query methods or explicitly unsafe ORM methods;
- local or global TLS certificate verification bypasses.

Runtime sink checks use the TypeScript syntax tree and recognize aliased ESM
imports, namespace imports, and CommonJS `require()` bindings. A dynamic shell
or SQL value is critical when it is visibly derived from request data or
`process.argv`; other non-literal values are warnings. Dynamic code execution
and disabled TLS verification are always critical.

## Scope

Runtime checks inspect JavaScript and TypeScript files. Test and fixture paths
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
excluded. CodeDiag does not currently provide per-rule suppression comments.

## Limits

The analysis is intentionally conservative. It does not perform whole-program
taint tracking, inspect Git history for removed secrets, prove authorization
correctness, or replace dependency advisories and a full SAST review. Dynamic
imports, wrapper functions, custom database APIs, and values assembled across
multiple modules may not be recognized.

Treat findings as review prompts with source locations and fixes. A clean scan
means the implemented checks passed; it is not proof that an application is
secure.
