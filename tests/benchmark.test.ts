import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { isActive } from "../src/core/issues.js";
import { scan } from "../src/scanner.js";
import type { DiagnosticIssue, ScanResult } from "../src/types.js";

/**
 * Regression net for analyzer changes: realistic, well-built projects must
 * keep a high score with no critical findings, and known-bad projects must
 * keep producing the findings they were written to trigger.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");

async function scanFixture(name: string): Promise<ScanResult> {
  const directory = join(FIXTURES, name);
  const config = loadConfig(directory);
  // Dependency audits need the network; every other analyzer runs offline.
  config.analyzers.dependencies = false;
  return scan(directory, config, { interactive: false });
}

function findings(result: ScanResult): DiagnosticIssue[] {
  return result.analyzers.flatMap((analyzer) =>
    analyzer.issues.filter(isActive),
  );
}

function describe(result: ScanResult): string {
  return findings(result)
    .map((issue) => `${issue.severity} ${issue.rule}: ${issue.message}`)
    .join("\n");
}

for (const [name, framework] of [
  ["realistic/nestjs", "nestjs"],
  ["realistic/express", "express"],
  ["realistic/fastify", "fastify"],
  ["realistic/hono", "hono"],
  ["realistic/nextjs", "nextjs"],
  // A T3 app: tRPC procedures served by a Next.js route handler.
  ["realistic/trpc", "nextjs"],
] as const) {
  test(`${name} scores at least 85 with no critical findings`, async () => {
    const result = await scanFixture(name);

    assert.equal(result.stack.framework, framework);
    assert.ok(result.totalScore >= 85, describe(result));
    assert.deepEqual(
      findings(result).filter((issue) => issue.severity === "critical"),
      [],
    );
    assert.equal(
      result.analyzers.some((analyzer) => analyzer.name === "API Health"),
      true,
    );
  });
}

test("defects/express keeps its routing, injection, and web sink findings", async () => {
  const result = await scanFixture("defects/express");
  const located = findings(result)
    .filter((issue) => issue.file === "src/app.js")
    .map(({ rule, severity, line, message }) => ({
      rule,
      severity,
      line,
      message,
    }));

  assert.deepEqual(located, [
    {
      rule: "missing-auth-middleware",
      severity: "warning",
      line: 7,
      message: "DELETE /admin/users/:id has no recognizable auth middleware",
    },
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      line: 11,
      message: "Shell execution receives a non-literal command",
    },
    {
      rule: "dynamic-sql-query",
      severity: "critical",
      line: 17,
      message: "SQL execution uses a dynamically constructed query",
    },
    {
      rule: "path-traversal",
      severity: "critical",
      line: 23,
      message: "A file path is built from request data",
    },
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      line: 27,
      message: "An outgoing HTTP request uses a URL chosen by request data",
    },
    {
      rule: "open-redirect",
      severity: "warning",
      line: 32,
      message: "A redirect target comes from request data",
    },
    {
      rule: "reflected-xss",
      severity: "critical",
      line: 36,
      message: "Request data is written into an HTML response without escaping",
    },
  ]);
});

test("defects/express-session keeps its JWT, cookie, injection, and secret findings", async () => {
  const result = await scanFixture("defects/express-session");
  const located = findings(result)
    .filter((issue) => issue.line !== undefined)
    .map(
      ({ rule, severity, file, line }) => `${severity} ${rule} ${file}:${line}`,
    )
    .sort();

  assert.deepEqual(located, [
    "critical committed-env-secret .env.production:2",
    "critical dynamic-command-execution src/account.js:37",
    "critical hardcoded-secret config/production.json:5",
    "critical jwt-none-algorithm src/account.js:20",
    "critical prototype-pollution src/account.js:32",
    "critical server-side-template-injection src/account.js:27",
    "warning insecure-cookie src/account.js:10",
    "warning insecure-cookie src/account.js:14",
    "warning jwt-expiration-ignored src/account.js:21",
  ]);
});

test("defects/express-helpers follows request data into and out of helper modules", async () => {
  const result = await scanFixture("defects/express-helpers");
  const security = result.analyzers.find(
    (analyzer) => analyzer.name === "Security",
  );
  const located = (security?.issues ?? [])
    .filter((issue) => issue.line !== undefined)
    .map(
      ({ rule, severity, file, line, confidence }) =>
        `${severity} ${rule} ${file}:${line} ${confidence ?? "high"}`,
    )
    .sort();

  assert.deepEqual(located, [
    "critical dynamic-command-execution src/lib/convert.js:4 medium",
    "critical dynamic-sql-query src/services/reports.js:7 medium",
    "critical path-traversal src/lib/files.js:7 medium",
    "warning server-side-request-forgery src/app.js:25 medium",
  ]);
  const traversal = security?.issues.find(
    (issue) => issue.rule === "path-traversal",
  );
  assert.match(
    traversal?.fix ?? "",
    /^Request data reaches this call from src\/app\.js:12; /,
  );
});

test("defects/fastify keeps its auth hook, schema, and error handler findings", async () => {
  const result = await scanFixture("defects/fastify");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.deepEqual(
    api?.issues.map(({ rule, severity, line, message, confidence }) => ({
      rule,
      severity,
      line,
      message,
      confidence,
    })),
    [
      {
        rule: "missing-auth-hook",
        severity: "warning",
        line: 6,
        message: "DELETE /admin/users/:id has no recognizable auth hook",
        confidence: "high",
      },
      {
        rule: "missing-auth-hook",
        severity: "warning",
        line: 17,
        message: "POST /webhooks has no recognizable auth hook",
        confidence: "high",
      },
      {
        rule: "missing-route-schema",
        severity: "warning",
        line: 11,
        message: "PATCH /account/profile has no request body schema",
        confidence: "high",
      },
      {
        rule: "missing-error-handler",
        severity: "warning",
        line: undefined,
        message:
          "No Fastify error handler is registered with setErrorHandler()",
        confidence: undefined,
      },
      {
        rule: "missing-health-endpoint",
        severity: "info",
        line: undefined,
        message: "No health, readiness, or liveness endpoint detected",
        confidence: undefined,
      },
    ],
  );
});

test("defects/hono keeps its middleware order, validator, and error handler findings", async () => {
  const result = await scanFixture("defects/hono");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.equal(result.stack.framework, "hono");
  assert.deepEqual(
    api?.issues.map(({ rule, severity, line, message, confidence }) => ({
      rule,
      severity,
      line,
      message,
      confidence,
    })),
    [
      {
        rule: "missing-hono-auth-middleware",
        severity: "warning",
        line: 10,
        message: "DELETE /admin/users/:id has no recognizable auth middleware",
        confidence: "high",
      },
      {
        rule: "missing-hono-auth-middleware",
        severity: "warning",
        line: 21,
        message: "POST /webhooks has no recognizable auth middleware",
        confidence: "high",
      },
      {
        rule: "missing-hono-validator",
        severity: "warning",
        line: 17,
        message: "PATCH /account/:id has no json or form validator",
        confidence: "high",
      },
      {
        rule: "missing-hono-validator",
        severity: "warning",
        line: 21,
        message: "POST /webhooks has no json or form validator",
        confidence: "high",
      },
      {
        rule: "missing-hono-error-handler",
        severity: "info",
        line: undefined,
        message: "No Hono error handler is registered with onError()",
        confidence: undefined,
      },
      {
        rule: "missing-health-endpoint",
        severity: "info",
        line: undefined,
        message: "No health, readiness, or liveness endpoint detected",
        confidence: undefined,
      },
    ],
  );
});

test("realistic/trpc checks every procedure without findings", async () => {
  const result = await scanFixture("realistic/trpc");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.equal(result.totalScore, 100, describe(result));
  assert.deepEqual(findings(result), []);
  assert.equal(
    api?.summary,
    "1 Next.js handlers across 2 API route files; 7 tRPC procedures in 3 routers",
  );
});

test("defects/trpc keeps its procedure, input, stack trace, and injection findings", async () => {
  const result = await scanFixture("defects/trpc");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );
  const security = result.analyzers.find(
    (analyzer) => analyzer.name === "Security",
  );

  assert.equal(result.stack.framework, "trpc");
  assert.deepEqual(
    api?.issues.map(({ rule, file, line, message, confidence }) => ({
      rule,
      at: `${file}:${line}`,
      message,
      confidence,
    })),
    [
      {
        rule: "missing-trpc-auth-middleware",
        at: "src/routers/admin.ts:10",
        message:
          "Mutation admin.users.delete has no recognizable auth middleware",
        confidence: "high",
      },
      {
        rule: "missing-trpc-auth-middleware",
        at: "src/routers/files.ts:16",
        message: "Mutation files.upload has no recognizable auth middleware",
        confidence: "high",
      },
      {
        rule: "missing-trpc-auth-middleware",
        at: "src/routers/posts.ts:13",
        message: "Mutation posts.create has no recognizable auth middleware",
        confidence: "high",
      },
      {
        rule: "unvalidated-trpc-input",
        at: "src/routers/files.ts:16",
        message:
          "Input of mutation files.upload is not validated: z.any() accepts any value",
        confidence: "high",
      },
      {
        rule: "unvalidated-trpc-input",
        at: "src/routers/files.ts:18",
        message:
          "Input of mutation files.rename is not validated: the parser returns its argument without checking it",
        confidence: "high",
      },
      {
        rule: "trpc-stack-trace-exposed",
        at: "src/trpc.ts:6",
        message:
          "initTRPC.create() sets isDev: true, so error responses include stack traces in production",
        confidence: undefined,
      },
      {
        rule: "trpc-stack-trace-exposed",
        at: "src/trpc.ts:8",
        message:
          "The tRPC errorFormatter returns error.stack in every environment",
        confidence: undefined,
      },
    ],
  );
  assert.deepEqual(
    (security?.issues ?? [])
      .filter((issue) => issue.line !== undefined)
      .map(
        ({ rule, severity, file, line, confidence }) =>
          `${severity} ${rule} ${file}:${line} ${confidence ?? "high"}`,
      )
      .sort(),
    [
      "critical dynamic-command-execution src/lib/convert.ts:4 medium",
      "critical dynamic-command-execution src/routers/files.ts:9 high",
      "critical path-traversal src/routers/files.ts:12 high",
    ],
  );
});

test("defects/nestjs honors the global guard and flags the untyped body", async () => {
  const result = await scanFixture("defects/nestjs");
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.deepEqual(
    api?.issues.map((issue) => issue.message),
    [
      "POST /users uses Record<string, any> for its request body; declare a DTO class",
    ],
  );
});
