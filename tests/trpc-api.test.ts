import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeTrpcApi } from "../src/analyzers/trpc-api.js";
import { loadConfig } from "../src/config.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";

const TRPC_SERVER = { "@trpc/server": "^11.0.0", zod: "^3.23.0" };

/** A tRPC instance with a public and a protected builder, as most apps have. */
const TRPC_SETUP = [
  'import { initTRPC, TRPCError } from "@trpc/server";',
  "const t = initTRPC.context<{ user: { id: string } | null }>().create();",
  "export const router = t.router;",
  "export const middleware = t.middleware;",
  "export const publicProcedure = t.procedure;",
  "export const protectedProcedure = t.procedure.use(({ ctx, next }) => {",
  '  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });',
  "  return next({ ctx: { user: ctx.user } });",
  "});",
].join("\n");

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = TRPC_SERVER,
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-trpc-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "trpc-fixture", dependencies }),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

async function analyze(files: Record<string, string>) {
  const directory = createProject(files);
  try {
    return await analyzeTrpcApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Result = Awaited<ReturnType<typeof analyze>>;

function findings(result: Result, rule: string) {
  return (result?.issues ?? [])
    .filter((issue) => issue.rule === rule)
    .map(({ message, file, line, confidence }) => ({
      message,
      file,
      line,
      confidence,
    }));
}

function authMessages(result: Result): string[] {
  return findings(result, "missing-trpc-auth-middleware").map(
    (finding) => finding.message,
  );
}

async function scanProject(
  files: Record<string, string>,
  dependencies: Record<string, string>,
) {
  const directory = createProject(files, dependencies);
  try {
    const config = loadConfig(directory);
    config.analyzers.dependencies = false;
    return await scan(directory, config, { interactive: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("tRPC projects keep the framework of the server they run in", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [TRPC_SERVER, "trpc"],
    [{ ...TRPC_SERVER, next: "^15.0.0" }, "nextjs"],
    [{ ...TRPC_SERVER, express: "^5.0.0" }, "express"],
    [{ ...TRPC_SERVER, fastify: "^5.0.0" }, "fastify"],
    [{ ...TRPC_SERVER, hono: "^4.6.0" }, "hono"],
    [{ ...TRPC_SERVER, "@nestjs/core": "^10.0.0" }, "nestjs"],
    [{ "@trpc/client": "^11.0.0" }, "generic"],
  ];

  for (const [dependencies, framework] of cases) {
    const directory = createProject({}, dependencies);
    try {
      assert.equal(detectStack(directory).framework, framework);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("builders imported across files are judged by their middleware", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/routers/post.ts": [
      'import { z } from "zod";',
      'import { protectedProcedure, publicProcedure, router } from "../trpc.js";',
      "export const postRouter = router({",
      "  list: publicProcedure.query(() => []),",
      "  create: protectedProcedure",
      "    .input(z.object({ title: z.string() }))",
      "    .mutation(({ input }) => input.title),",
      "  vote: publicProcedure",
      "    .input(z.object({ id: z.string() }))",
      "    .mutation(({ input }) => input.id),",
      "});",
    ].join("\n"),
    "src/root.ts": [
      'import { router } from "./trpc.js";',
      'import { postRouter } from "./routers/post.js";',
      "export const appRouter = router({ post: postRouter });",
    ].join("\n"),
  });

  assert.deepEqual(findings(result, "missing-trpc-auth-middleware"), [
    {
      message: "Mutation post.vote has no recognizable auth middleware",
      file: "src/routers/post.ts",
      line: 10,
      confidence: "high",
    },
  ]);
  assert.match(result?.summary ?? "", /^3 tRPC procedures in 2 routers$/);
});

test("builders imported through tsconfig paths resolve; package builders fall back to names", async () => {
  const result = await analyze({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, paths: { "~/*": ["./src/*"] } },
    }),
    "src/server/trpc.ts": [
      'import { initTRPC } from "@trpc/server";',
      "const t = initTRPC.create();",
      "export const createTRPCRouter = t.router;",
      "// Named as protected, but its middleware only times requests.",
      "export const protectedProcedure = t.procedure.use(async ({ next }) => next());",
    ].join("\n"),
    "src/server/routers/post.ts": [
      'import { createTRPCRouter, protectedProcedure } from "~/server/trpc";',
      'import { authedProcedure, publicProcedure } from "@acme/api";',
      "export const postRouter = createTRPCRouter({",
      "  create: protectedProcedure.mutation(() => 1),",
      "  update: authedProcedure.mutation(() => 2),",
      "  like: publicProcedure.mutation(() => 3),",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(findings(result, "missing-trpc-auth-middleware"), [
    {
      message: "Mutation create has no recognizable auth middleware",
      file: "src/server/routers/post.ts",
      line: 4,
      confidence: "high",
    },
    {
      message: "Mutation like has no recognizable auth middleware",
      file: "src/server/routers/post.ts",
      line: 6,
      confidence: "low",
    },
  ]);
});

test("nested, record, spread, and merged routers name procedures by their full path", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/app.ts": [
      'import { initTRPC } from "@trpc/server";',
      'import { mergeRouters } from "@trpc/server";',
      'import { publicProcedure, router } from "./trpc.js";',
      "const removeUser = publicProcedure.mutation(() => true);",
      "const shared = { archive: publicProcedure.mutation(() => true) };",
      "const adminRouter = router({",
      "  users: router({ remove: removeUser }),",
      "  settings: { theme: { reset: publicProcedure.mutation(() => true) } },",
      "  ...shared,",
      "});",
      "const health = router({ healthcheck: publicProcedure.query(() => 'ok') });",
      "export const appRouter = mergeRouters(health, router({ admin: adminRouter }));",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "Mutation admin.users.remove has no recognizable auth middleware",
    "Mutation admin.archive has no recognizable auth middleware",
    "Mutation admin.settings.theme.reset has no recognizable auth middleware",
  ]);
  assert.deepEqual(findings(result, "missing-health-endpoint"), []);
});

test("t.mergeRouters and destructured instance members are recognized", async () => {
  const result = await analyze({
    "src/trpc.ts": [
      'import { initTRPC } from "@trpc/server";',
      "const t = initTRPC.create();",
      "export const { router, mergeRouters, procedure } = t;",
      "export const publicProcedure = t.procedure;",
    ].join("\n"),
    "src/root.ts": [
      'import { mergeRouters, procedure, publicProcedure, router } from "./trpc.js";',
      "const a = router({ ping: publicProcedure.mutation(() => 'pong') });",
      "const b = router({ users: router({ add: procedure.mutation(() => 1) }) });",
      "export const appRouter = mergeRouters(a, b);",
    ].join("\n"),
  });

  assert.deepEqual(
    findings(result, "missing-trpc-auth-middleware").map(
      ({ message, confidence }) => ({ message, confidence }),
    ),
    [
      {
        message: "Mutation ping has no recognizable auth middleware",
        confidence: "high",
      },
      {
        message: "Mutation users.add has no recognizable auth middleware",
        confidence: "high",
      },
    ],
  );
  assert.match(result?.summary ?? "", / in 4 routers$/);
});

test("auth middleware counts anywhere in the chain, but a discarded use() does not", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/routers.ts": [
      'import { z } from "zod";',
      'import { TRPCError } from "@trpc/server";',
      'import { middleware, publicProcedure, router } from "./trpc.js";',
      "const timing = middleware(async ({ next }) => next());",
      "const isAuthed = middleware(({ ctx, next }) => {",
      '  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });',
      "  return next();",
      "});",
      "const isAdmin = isAuthed.unstable_pipe(({ ctx, next }) => next());",
      "const base = publicProcedure;",
      "// Builders are immutable: this protected builder is thrown away.",
      "base.use(isAuthed);",
      "export const appRouter = router({",
      "  first: publicProcedure.use(isAuthed).use(timing).mutation(() => 1),",
      "  last: publicProcedure.use(timing).input(z.string()).use(isAuthed).mutation(() => 2),",
      "  piped: publicProcedure.use(isAdmin).mutation(() => 3),",
      "  discarded: base.mutation(() => 4),",
      "  timed: publicProcedure.use(timing).mutation(() => 5),",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "Mutation discarded has no recognizable auth middleware",
    "Mutation timed has no recognizable auth middleware",
  ]);
});

test("middleware factories, FORBIDDEN, identity guards, and auth names count as auth", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/guards.ts": [
      'import { TRPCError } from "@trpc/server";',
      'import { middleware } from "./trpc.js";',
      "export function requireRole(role: string) {",
      "  return middleware(({ ctx, next }) => {",
      '    if (ctx.user?.id !== role) throw new TRPCError({ code: "FORBIDDEN" });',
      "    return next();",
      "  });",
      "}",
      "export const signedIn = middleware(({ ctx, next }) => {",
      '  if (!ctx.user) throw new Error("Sign in first");',
      "  return next();",
      "});",
      "export function tenant() {",
      "  return middleware(({ next }) => next());",
      "}",
    ].join("\n"),
    "src/routers.ts": [
      'import { clerkAuth, rateLimit } from "@acme/middleware";',
      'import { requireRole, signedIn, tenant } from "./guards.js";',
      'import { publicProcedure, router } from "./trpc.js";',
      "export const appRouter = router({",
      '  ban: publicProcedure.use(requireRole("admin")).mutation(() => 1),',
      "  post: publicProcedure.use(signedIn).mutation(() => 2),",
      "  pay: publicProcedure.use(clerkAuth).mutation(() => 3),",
      "  send: publicProcedure.use(rateLimit({ max: 5 })).mutation(() => 4),",
      "  move: publicProcedure.use(tenant()).mutation(() => 5),",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(
    findings(result, "missing-trpc-auth-middleware").map(
      ({ message, confidence }) => ({ message, confidence }),
    ),
    [
      {
        message: "Mutation send has no recognizable auth middleware",
        confidence: "low",
      },
      {
        message: "Mutation move has no recognizable auth middleware",
        confidence: "high",
      },
    ],
  );
});

test("queries, subscriptions, and client calls are not reported", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/routers.ts": [
      'import { publicProcedure, router } from "./trpc.js";',
      "export const appRouter = router({",
      "  list: publicProcedure.query(() => []),",
      "  onPost: publicProcedure.subscription(async function* () {}),",
      "});",
    ].join("\n"),
    "src/client.ts": [
      'import { createTRPCClient } from "@trpc/client";',
      "const client = createTRPCClient<never>({ links: [] });",
      "await client.post.byId.query({ id: 1 });",
      'await client.post.create.mutate({ title: "x" });',
      "await db.query((tx) => tx.select());",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), []);
  assert.match(result?.summary ?? "", /^2 tRPC procedures in 1 router$/);
});

test("input parsers that accept anything are reported once where they are declared", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/schemas.ts": [
      'import { z } from "zod";',
      "export const anything = z.unknown().optional();",
    ].join("\n"),
    "src/routers.ts": [
      'import * as v from "valibot";',
      'import { z } from "zod";',
      'import { anything } from "./schemas.js";',
      'import { protectedProcedure as p, router } from "./trpc.js";',
      "const loose = p.input(z.any());",
      "export const appRouter = router({",
      "  a: loose.mutation(() => 1),",
      "  b: loose.query(() => 2),",
      "  c: p.input(anything).query(() => 3),",
      "  d: p.input(z.custom<{ id: string }>()).query(() => 4),",
      "  e: p.input(v.optional(v.any())).query(() => 5),",
      "  f: p.input((value) => value as { id: string }).query(() => 6),",
      "  g: p.input(function (raw: unknown) { return raw as string; }).query(() => 7),",
      "  ok1: p.input(z.object({ data: z.any() })).query(() => 8),",
      "  ok2: p.input(z.custom<string>((value) => typeof value === 'string')).query(() => 9),",
      "  ok3: p.input((value) => {",
      "    if (typeof value !== 'string') throw new Error('Expected a string');",
      "    return value;",
      "  }).query(() => 10),",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(findings(result, "unvalidated-trpc-input"), [
    {
      message:
        "Input of mutation a is not validated: z.any() accepts any value",
      file: "src/routers.ts",
      line: 5,
      confidence: "high",
    },
    {
      message:
        "Input of query c is not validated: z.unknown() accepts any value",
      file: "src/routers.ts",
      line: 9,
      confidence: "high",
    },
    {
      message:
        "Input of query d is not validated: z.custom<{ id: string }>() accepts any value",
      file: "src/routers.ts",
      line: 10,
      confidence: "high",
    },
    {
      message: "Input of query e is not validated: v.any() accepts any value",
      file: "src/routers.ts",
      line: 11,
      confidence: "high",
    },
    {
      message:
        "Input of query f is not validated: the parser returns its argument without checking it",
      file: "src/routers.ts",
      line: 12,
      confidence: "high",
    },
    {
      message:
        "Input of query g is not validated: the parser returns its argument without checking it",
      file: "src/routers.ts",
      line: 13,
      confidence: "high",
    },
  ]);
});

test("stack traces are reported for isDev: true and unconditional errorFormatter stacks", async () => {
  const leaky = await analyze({
    "src/trpc.ts": [
      'import { initTRPC } from "@trpc/server";',
      "const t = initTRPC.create({",
      "  isDev: true,",
      "  errorFormatter: ({ shape, error }) => ({ ...shape, stack: error.cause?.stack }),",
      "});",
      "export const appRouter = t.router({ ping: t.procedure.query(() => 'pong') });",
    ].join("\n"),
  });
  const careful = await analyze({
    "src/trpc.ts": [
      'import { initTRPC } from "@trpc/server";',
      'const isDev = process.env.NODE_ENV !== "production";',
      "const t = initTRPC.create({",
      "  isDev,",
      "  errorFormatter({ shape, error }) {",
      "    console.error(error.stack);",
      "    if (isDev) return { ...shape, stack: error.stack };",
      "    return {",
      "      ...shape,",
      "      trace: isDev ? error.stack : undefined,",
      "      extra: isDev && { stack: error.stack },",
      "      safe: redact(error.stack),",
      "      data: { ...shape.data, stack: shape.data.stack },",
      "    };",
      "  },",
      "});",
      "export const appRouter = t.router({ ping: t.procedure.query(() => 'pong') });",
    ].join("\n"),
  });

  assert.deepEqual(findings(leaky, "trpc-stack-trace-exposed"), [
    {
      message:
        "initTRPC.create() sets isDev: true, so error responses include stack traces in production",
      file: "src/trpc.ts",
      line: 3,
      confidence: undefined,
    },
    {
      message:
        "The tRPC errorFormatter returns error.cause?.stack in every environment",
      file: "src/trpc.ts",
      line: 4,
      confidence: undefined,
    },
  ]);
  assert.deepEqual(findings(careful, "trpc-stack-trace-exposed"), []);
});

test("a standalone tRPC server reports a missing health procedure", async () => {
  const result = await analyze({
    "src/server.ts": [
      'import { initTRPC } from "@trpc/server";',
      'import { createHTTPServer } from "@trpc/server/adapters/standalone";',
      "const t = initTRPC.create();",
      "const appRouter = t.router({ greet: t.procedure.query(() => 'hi') });",
      "createHTTPServer({ router: appRouter }).listen(3000);",
    ].join("\n"),
  });

  assert.equal(result?.score, 85);
  assert.deepEqual(
    result?.issues.map((issue) => issue.rule),
    ["missing-health-endpoint"],
  );
});

test("a tRPC client package without procedures has no API Health score", async () => {
  const result = await analyze({
    "src/client.ts": [
      'import { createTRPCClient, httpBatchLink } from "@trpc/client";',
      'import type { AppRouter } from "@acme/api";',
      'export const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/trpc" })] });',
    ].join("\n"),
  });

  assert.equal(result, null);
});

test("an Express app serving tRPC combines routes and procedures", async () => {
  const result = await scanProject(
    {
      "src/trpc.ts": TRPC_SETUP,
      "src/router.ts": [
        'import { publicProcedure, router } from "./trpc.js";',
        "export const appRouter = router({ reset: publicProcedure.mutation(() => 1) });",
      ].join("\n"),
      "src/app.ts": [
        'import express from "express";',
        'import { createExpressMiddleware } from "@trpc/server/adapters/express";',
        'import { appRouter } from "./router.js";',
        "const app = express();",
        'app.get("/health", (req, res) => res.json({ ok: true }));',
        'app.use("/trpc", createExpressMiddleware({ router: appRouter }));',
        "app.use((err, req, res, next) => res.status(500).json({ error: 'Internal' }));",
      ].join("\n"),
    },
    { ...TRPC_SERVER, express: "^5.0.0" },
  );
  const api = result.analyzers.find(
    (analyzer) => analyzer.name === "API Health",
  );

  assert.equal(result.stack.framework, "express");
  assert.deepEqual(
    api?.issues.map((issue) => issue.rule),
    ["missing-trpc-auth-middleware"],
  );
  assert.match(
    api?.summary ?? "",
    /Express endpoints .*; 1 tRPC procedure in 1 router$/,
  );
});

test("a server whose only endpoints are tRPC procedures is not reported as empty", async () => {
  const procedures = {
    "src/trpc.ts": TRPC_SETUP,
    "src/router.ts": [
      'import { protectedProcedure, publicProcedure, router } from "./trpc.js";',
      "export const appRouter = router({",
      "  health: publicProcedure.query(() => 'ok'),",
      "  save: protectedProcedure.mutation(() => 1),",
      "});",
    ].join("\n"),
  };
  const express = await scanProject(
    {
      ...procedures,
      "src/app.ts": [
        'import express from "express";',
        'import * as trpcExpress from "@trpc/server/adapters/express";',
        'import { appRouter } from "./router.js";',
        "const app = express();",
        'app.use("/trpc", trpcExpress.createExpressMiddleware({ router: appRouter }));',
      ].join("\n"),
    },
    { ...TRPC_SERVER, express: "^5.0.0" },
  );
  const pages = await scanProject(
    {
      ...procedures,
      "src/pages/api/trpc/[trpc].ts": [
        'import { createNextApiHandler } from "@trpc/server/adapters/next";',
        'import { appRouter } from "../../../router.js";',
        "export default createNextApiHandler({ router: appRouter });",
      ].join("\n"),
    },
    { ...TRPC_SERVER, next: "^15.0.0" },
  );

  for (const result of [express, pages]) {
    const api = result.analyzers.find(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.equal(api?.score, 100, JSON.stringify(api?.issues));
    assert.equal(api?.summary, "2 tRPC procedures in 1 router");
  }
});

test("a tRPC handler for a router in another package leaves API Health not applicable", async () => {
  const result = await scanProject(
    {
      "src/app/api/trpc/[trpc]/route.ts": [
        'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";',
        'import { appRouter, createTRPCContext } from "@acme/api";',
        "const handler = (req: Request) =>",
        '  fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext: () => createTRPCContext({ headers: req.headers }) });',
        "export { handler as GET, handler as POST };",
      ].join("\n"),
    },
    { ...TRPC_SERVER, next: "^15.0.0" },
  );

  assert.equal(result.stack.framework, "nextjs");
  assert.equal(
    result.analyzers.some((analyzer) => analyzer.name === "API Health"),
    false,
  );
});

test("tRPC procedures in test files are ignored", async () => {
  const result = await analyze({
    "src/trpc.ts": TRPC_SETUP,
    "src/router.test.ts": [
      'import { publicProcedure, router } from "./trpc.js";',
      "const testRouter = router({ reset: publicProcedure.mutation(() => 1) });",
    ].join("\n"),
  });

  assert.equal(result, null);
});

/** A router with one mutation on the public builder, served by an adapter. */
const PERIMETER_ROUTER = {
  "src/server/trpc.ts": TRPC_SETUP,
  "src/server/router.ts": [
    'import { z } from "zod";',
    'import { publicProcedure, router } from "./trpc";',
    "export const appRouter = router({",
    "  createPost: publicProcedure",
    "    .input(z.object({ title: z.string() }))",
    "    .mutation(({ input }) => input),",
    "});",
  ].join("\n"),
};
const UNPROTECTED = ["Mutation createPost has no recognizable auth middleware"];

test("a createContext that rejects anonymous callers protects every procedure", async () => {
  const rejecting = [
    'import { TRPCError } from "@trpc/server";',
    'import { getSession } from "./session";',
    "export async function createContext({ req }) {",
    "  const session = await getSession(req);",
    '  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });',
    "  return { user: session.user };",
    "}",
  ].join("\n");
  const standalone = await analyze({
    ...PERIMETER_ROUTER,
    "src/server/context.ts": rejecting,
    "src/server/index.ts": [
      'import { createHTTPServer } from "@trpc/server/adapters/standalone";',
      'import { createContext } from "./context";',
      'import { appRouter } from "./router";',
      "createHTTPServer({ router: appRouter, createContext }).listen(3000);",
    ].join("\n"),
  });
  assert.deepEqual(authMessages(standalone), []);
  assert.match(
    standalone?.summary ?? "",
    /; createContext in src\/server\/context\.ts rejects anonymous callers$/,
  );

  // Followed through an inline arrow that calls the project's function.
  const fetchAdapter = await analyze({
    ...PERIMETER_ROUTER,
    "src/server/context.ts": rejecting,
    "src/app/api/trpc/[trpc]/route.ts": [
      'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";',
      'import { createContext } from "../../../../server/context";',
      'import { appRouter } from "../../../../server/router";',
      "const handler = (req: Request) =>",
      "  fetchRequestHandler({",
      '    endpoint: "/api/trpc",',
      "    req,",
      "    router: appRouter,",
      "    createContext: () => createContext({ req }),",
      "  });",
      "export { handler as GET, handler as POST };",
    ].join("\n"),
  });
  assert.deepEqual(authMessages(fetchAdapter), []);

  // Reading the session is not rejecting the caller (T3's createTRPCContext).
  const reading = await analyze({
    ...PERIMETER_ROUTER,
    "src/server/context.ts": [
      'import { auth } from "./auth";',
      "export async function createContext() {",
      "  const session = await auth();",
      "  return { session, user: session?.user ?? null };",
      "}",
    ].join("\n"),
    "src/server/index.ts": [
      'import { createHTTPServer } from "@trpc/server/adapters/standalone";',
      'import { createContext } from "./context";',
      'import { appRouter } from "./router";',
      "createHTTPServer({ router: appRouter, createContext }).listen(3000);",
    ].join("\n"),
  });
  assert.deepEqual(authMessages(reading), UNPROTECTED);
});

test("auth middleware on the Express mount that serves tRPC protects its procedures", async () => {
  const app = (...lines: string[]) => ({
    ...PERIMETER_ROUTER,
    "src/app.ts": [
      'import express from "express";',
      'import * as trpcExpress from "@trpc/server/adapters/express";',
      'import { requireAuth } from "./auth";',
      'import { appRouter } from "./server/router";',
      "const app = express();",
      "const trpc = trpcExpress.createExpressMiddleware({ router: appRouter });",
      ...lines,
    ].join("\n"),
  });

  const mounted = await analyze(app('app.use("/trpc", requireAuth, trpc);'));
  assert.deepEqual(authMessages(mounted), []);
  assert.match(
    mounted?.summary ?? "",
    /; requireAuth runs before the tRPC mount in src\/app\.ts$/,
  );
  assert.deepEqual(
    authMessages(
      await analyze(app("app.use(requireAuth);", 'app.use("/trpc", trpc);')),
    ),
    [],
  );

  for (const lines of [
    ['app.use("/admin", requireAuth);', 'app.use("/trpc", trpc);'],
    ['app.use("/trpc", trpc);', "app.use(requireAuth);"],
    ['app.use("/trpc", trpc);'],
  ]) {
    assert.deepEqual(authMessages(await analyze(app(...lines))), UNPROTECTED);
  }
});

test("a Next.js middleware that rejects anonymous requests to the tRPC endpoint protects it", async () => {
  const project = (middleware: Record<string, string>) => ({
    ...PERIMETER_ROUTER,
    "src/app/api/trpc/[trpc]/route.ts": [
      'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";',
      'import { appRouter } from "../../../../server/router";',
      "const handler = (req: Request) =>",
      '  fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext: () => ({ user: null }) });',
      "export { handler as GET, handler as POST };",
    ].join("\n"),
    ...middleware,
  });
  const custom = [
    'import { NextResponse, type NextRequest } from "next/server";',
    "export function middleware(request: NextRequest) {",
    '  const token = request.cookies.get("session")?.value;',
    "  if (!token) {",
    '    return NextResponse.redirect(new URL("/login", request.url));',
    "  }",
    "  return NextResponse.next();",
    "}",
  ];
  const protecting: Array<[string, Record<string, string>]> = [
    [
      "custom middleware without a matcher",
      { "src/middleware.ts": custom.join("\n") },
    ],
    [
      "Next.js 16 proxy",
      {
        "proxy.ts": custom
          .join("\n")
          .replace("function middleware", "function proxy"),
      },
    ],
    [
      "next-auth/middleware with a tRPC matcher",
      {
        "middleware.ts": [
          'export { default } from "next-auth/middleware";',
          'export const config = { matcher: ["/dashboard/:path*", "/api/trpc/:path*"] };',
        ].join("\n"),
      },
    ],
    [
      "Clerk protecting a matched route",
      {
        "src/middleware.ts": [
          'import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";',
          'const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/api/trpc(.*)"]);',
          "export default clerkMiddleware(async (auth, req) => {",
          "  if (isProtectedRoute(req)) await auth.protect();",
          "});",
          'export const config = { matcher: ["/((?!_next|.*\\\\..*).*)", "/(api|trpc)(.*)"] };',
        ].join("\n"),
      },
    ],
  ];
  for (const [name, files] of protecting) {
    const result = await analyze(project(files));
    assert.deepEqual(authMessages(result), [], name);
    assert.match(result?.summary ?? "", /middleware|proxy/, name);
  }

  const leaving: Array<[string, Record<string, string>]> = [
    ["no middleware", {}],
    [
      "a matcher that excludes the API",
      {
        "middleware.ts": [
          'export { default } from "next-auth/middleware";',
          'export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };',
        ].join("\n"),
      },
    ],
    [
      "a matcher for other pages",
      {
        "middleware.ts": [
          'export { default } from "next-auth/middleware";',
          'export const config = { matcher: ["/dashboard/:path*"] };',
        ].join("\n"),
      },
    ],
    [
      "Clerk protecting other routes",
      {
        "middleware.ts": [
          'import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";',
          'const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);',
          "export default clerkMiddleware(async (auth, req) => {",
          "  if (isProtectedRoute(req)) await auth.protect();",
          "});",
        ].join("\n"),
      },
    ],
    [
      "a middleware that only sets headers",
      {
        "middleware.ts": [
          'import { NextResponse } from "next/server";',
          "export function middleware() {",
          "  const response = NextResponse.next();",
          '  response.headers.set("x-frame-options", "DENY");',
          "  return response;",
          "}",
        ].join("\n"),
      },
    ],
  ];
  for (const [name, files] of leaving) {
    assert.deepEqual(
      authMessages(await analyze(project(files))),
      UNPROTECTED,
      name,
    );
  }
});
