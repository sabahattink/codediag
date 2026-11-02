import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeElysiaApi } from "../src/analyzers/elysia-api.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = { elysia: "^1.4.0" },
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-elysia-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "elysia-fixture", dependencies }),
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
    return await analyzeElysiaApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Result = Awaited<ReturnType<typeof analyze>>;

function authMessages(result: Result): string[] {
  return result.issues
    .filter((issue) => issue.rule === "missing-elysia-auth")
    .map((issue) => issue.message);
}

function validationMessages(result: Result): string[] {
  return result.issues
    .filter((issue) => issue.rule === "missing-elysia-validation")
    .map((issue) => issue.message);
}

const lines = (...source: string[]) => source.join("\n");

test("detects Elysia projects without overriding the servers it can run inside", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ elysia: "^1.4.0" }, "elysia"],
    [{ elysia: "^1.4.0", "@elysiajs/node": "^1.4.0" }, "elysia"],
    [{ next: "^15.0.0", elysia: "^1.4.0" }, "nextjs"],
    [{ hono: "^4.6.0", elysia: "^1.4.0" }, "hono"],
    [{ elysia: "^1.4.0", "@trpc/server": "^11.0.0" }, "elysia"],
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

test("a hook applies only to routes registered after it", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia, t } from "elysia";',
      "",
      "export const app = new Elysia()",
      '  .post("/feedback", ({ body }) => body, { body: t.Object({ text: t.String() }) })',
      "  .onBeforeHandle(({ user, status }) => {",
      "    if (!user) return status(401);",
      "  })",
      '  .post("/posts", ({ body }) => body, { body: t.Object({ title: t.String() }) })',
      '  .get("/health", () => "ok")',
      "  .onError(({ error }) => error);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /feedback has no recognizable auth check: the auth hook at src/index.ts:5 is registered after this route, and Elysia applies hooks only to routes registered after them",
  ]);
  assert.deepEqual(validationMessages(result), []);
  assert.equal(result.score, 83);
});

test("a plugin's local hook does not reach the instance that uses it", async () => {
  const result = await analyze({
    "src/auth.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "export const authLocal = new Elysia().onBeforeHandle(({ user, status }) => {",
      "  if (!user) return status(401);",
      "});",
      "",
      "export const authScoped = new Elysia().onBeforeHandle({ as: 'scoped' }, ({ user, status }) => {",
      "  if (!user) return status(401);",
      "});",
    ),
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import { authLocal, authScoped } from "./auth";',
      "",
      "new Elysia().use(authLocal).delete('/local/:id', ({ params }) => params.id);",
      "new Elysia().use(authScoped).delete('/scoped/:id', ({ params }) => params.id);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "DELETE /local/:id has no recognizable auth check: the auth hook at src/auth.ts:3 is local to its plugin, so it does not reach this route",
  ]);
});

test("scoped hooks reach one parent and global hooks reach every ancestor", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const requireUser = ({ user, status }) => {",
      "  if (!user) return status(401);",
      "};",
      "const scoped = new Elysia().onBeforeHandle({ as: 'scoped' }, requireUser);",
      "const global = new Elysia().derive({ as: 'global' }, ({ headers, status }) => {",
      "  if (!headers.authorization) return status(401);",
      "  return { token: headers.authorization };",
      "});",
      "const cast = new Elysia().onBeforeHandle(requireUser).as('scoped');",
      "",
      "const viaScoped = new Elysia().use(scoped).post('/a', () => 'a');",
      "const viaGlobal = new Elysia().use(global).post('/b', () => 'b');",
      "const viaCast = new Elysia().use(cast).post('/c', () => 'c');",
      "",
      "new Elysia().use(viaScoped).use(viaCast).post('/after-scoped', () => 'd');",
      "new Elysia().use(viaGlobal).post('/after-global', () => 'e');",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /after-scoped has no recognizable auth check",
  ]);
});

test("functional plugins register their hooks on the instance that uses them", async () => {
  const result = await analyze({
    "src/auth.ts": lines(
      'import type { Elysia } from "elysia";',
      "",
      "export const auth = (app: Elysia) =>",
      "  app.onBeforeHandle(({ session, status }) => {",
      "    if (!session) return status(401);",
      "  });",
    ),
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import { auth } from "./auth";',
      "",
      "new Elysia()",
      "  .use(auth)",
      "  .put('/profile', () => 'saved')",
      "  .use((app) => app.post('/inline', () => 'inline'));",
    ),
  });
  assert.deepEqual(authMessages(result), []);
});

test("guard() protects and validates the routes after it or in its callback", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia, t } from "elysia";',
      "",
      "const isSignedIn = ({ cookie, status }) => {",
      "  if (!cookie.session.value) return status(401, 'Unauthorized');",
      "};",
      "",
      "new Elysia()",
      "  .guard({ beforeHandle: isSignedIn, body: t.Object({ name: t.String() }) }, (app) =>",
      "    app.post('/inside', ({ body }) => body),",
      "  )",
      "  .post('/outside', ({ body }) => body)",
      "  .guard({ beforeHandle: [isSignedIn], body: t.Object({ id: t.Number() }) })",
      "  .patch('/later', ({ body }) => body);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /outside has no recognizable auth check: the auth hook at src/index.ts:12 is registered after this route, and Elysia applies hooks only to routes registered after them",
  ]);
  assert.deepEqual(validationMessages(result), [
    "POST /outside reads the request body without a schema",
  ]);
});

test("group() adds its prefix and its hook to the routes in its callback", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const API = '/api';",
      "",
      "new Elysia({ prefix: '/v1' })",
      "  .group(API, (api) =>",
      "    api",
      "      .group('/admin', { beforeHandle: ({ user, error }) => { if (!user?.admin) throw error(403); } }, (admin) =>",
      "        admin.delete('/users/:id', ({ params }) => params.id),",
      "      )",
      "      .delete('/posts/:id', ({ params }) => params.id),",
      "  );",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "DELETE /v1/api/posts/:id has no recognizable auth check",
  ]);
});

test("auth macros protect the routes that enable them", async () => {
  const result = await analyze({
    "src/auth.ts": lines(
      'import { Elysia } from "elysia";',
      'import { auth } from "./better-auth";',
      "",
      "export const betterAuth = new Elysia({ name: 'better-auth' })",
      "  .mount(auth.handler)",
      "  .macro({",
      "    auth: {",
      "      async resolve({ status, request: { headers } }) {",
      "        const session = await auth.api.getSession({ headers });",
      "        if (!session) return status(401);",
      "        return { user: session.user };",
      "      },",
      "    },",
      "    role(role: string) {",
      "      return { beforeHandle: ({ user, status }) => { if (!user) return status(403); } };",
      "    },",
      "    trace: { beforeHandle() { console.log('request'); } },",
      "  });",
    ),
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import { betterAuth } from "./auth";',
      "",
      "new Elysia()",
      "  .use(betterAuth)",
      "  .post('/posts', () => 'created', { auth: true })",
      "  .post('/admin', () => 'done', { role: 'admin' })",
      "  .post('/off', () => 'open', { auth: false })",
      "  .post('/traced', () => 'open', { trace: true });",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /off has no recognizable auth check",
    "POST /traced has no recognizable auth check",
  ]);
});

test("onRequest() protects every route of the application, wherever it is registered", async () => {
  const result = await analyze({
    "src/routes.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "export const routes = new Elysia({ prefix: '/records' }).delete('/:id', ({ params }) => params.id);",
    ),
    "src/server.ts": lines(
      'import { Elysia } from "elysia";',
      'import { routes } from "./routes";',
      "",
      "const isAuthorized = (header: string | null) => header === process.env.TOKEN;",
      "",
      "export const app = new Elysia()",
      "  .use(routes)",
      "  .onRequest(({ request }) => {",
      "    if (request.method !== 'OPTIONS' && !isAuthorized(request.headers.get('authorization'))) {",
      "      return new Response('Authentication required', { status: 401 });",
      "    }",
      "  });",
    ),
    "src/public.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "new Elysia().delete('/open/:id', ({ params }) => params.id);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "DELETE /open/:id has no recognizable auth check",
  ]);
});

test("derive() and resolve() protect only when they reject anonymous requests", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import { jwt } from "@elysiajs/jwt";',
      "",
      "new Elysia()",
      "  .use(jwt({ secret: process.env.SECRET! }))",
      "  .derive(async ({ jwt, cookie }) => ({ profile: await jwt.verify(cookie.auth.value) }))",
      "  .post('/derived', () => 'open')",
      "  .resolve(async ({ jwt, headers, status }) => {",
      "    const user = await jwt.verify(headers.authorization);",
      "    if (!user) return status(401);",
      "    return { user };",
      "  })",
      "  .post('/resolved', () => 'closed');",
      "",
      "new Elysia()",
      "  .derive(({ headers }) => ({ user: requireUser(headers) }))",
      "  .post('/required', () => 'closed');",
      "",
      "function requireUser(headers: Record<string, string | undefined>) {",
      "  if (!headers.authorization) throw new Error('Unauthorized');",
      "  return headers.authorization;",
      "}",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /derived has no recognizable auth check: the auth hook at src/index.ts:8 is registered after this route, and Elysia applies hooks only to routes registered after them",
  ]);
});

test("sign-in, sign-up, and recovery routes are public by design", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "new Elysia({ prefix: '/api' })",
      "  .post('/auth/register', () => 'registered')",
      "  .post('/sign-in', () => 'signed in')",
      "  .post('/forgot-password', () => 'sent')",
      "  .post('/logout', () => 'bye')",
      "  .post('/authors', () => 'created');",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /api/authors has no recognizable auth check",
  ]);
});

test("checks in the methods a derive() returns do not protect routes", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const service = new Elysia().derive({ as: 'scoped' }, ({ store }) => ({",
      "  async rename(user: { id: string } | null, name: string) {",
      "    if (!user) throw new Error('Unauthorized');",
      "    return store.rename(user.id, name);",
      "  },",
      "}));",
      "",
      "new Elysia().use(service).patch('/name', ({ rename }) => rename(null, 'x'));",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "PATCH /name has no recognizable auth check",
  ]);
});

test("handlers that reject anonymous requests or verify a webhook signature are protected", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import Stripe from "stripe";',
      "",
      "const stripe = new Stripe(process.env.STRIPE_KEY!);",
      "",
      "new Elysia()",
      "  .post('/clerk', ({ auth, error }) => {",
      "    if (!auth?.userId) return error(401);",
      "    return 'ok';",
      "  })",
      "  .post('/stripe', async ({ request, headers }) => {",
      "    const event = stripe.webhooks.constructEvent(await request.text(), headers['stripe-signature']!, process.env.WHSEC!);",
      "    return event.type;",
      "  })",
      "  .post('/anyone', () => 'open');",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /anyone has no recognizable auth check",
  ]);
});

test("validation is required only for handlers that read the body", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia, t } from "elysia";',
      'import { z } from "zod";',
      "",
      "const createUser = z.object({ email: z.string().email() });",
      "",
      "new Elysia()",
      "  .model({ note: t.Object({ text: t.String() }) })",
      "  .post('/zod', ({ body }) => body, { body: createUser })",
      "  .post('/model', ({ body }) => body, { body: 'note' })",
      "  .post('/parsed', ({ body }) => createUser.parse(body))",
      "  .post('/no-body/:id', ({ params }) => params.id)",
      "  .post('/static', 'ok')",
      "  .put('/raw', ({ body }) => body)",
      "  .patch('/context', (ctx) => ctx.body)",
      "  .post('/json', async ({ request }) => request.json())",
      "  .post('/passed', (ctx) => save(ctx));",
      "",
      "function save(value: unknown) {",
      "  return value;",
      "}",
    ),
  });
  assert.deepEqual(validationMessages(result), [
    "PUT /raw reads the request body without a schema",
    "PATCH /context reads the request body without a schema",
    "POST /json reads the request body without a schema",
    "POST /passed reads the request body without a schema",
  ]);
});

test("routes served through several instances are protected only if every one protects them", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const requireUser = ({ user, status }) => { if (!user) return status(401); };",
      "const notes = new Elysia({ prefix: '/notes' }).post('/', () => 'created');",
      "",
      "new Elysia().onBeforeHandle(requireUser).use(notes);",
      "new Elysia({ prefix: '/public' }).use(notes);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /public/notes has no recognizable auth check",
  ]);
});

test("a server shaped like db-studio's is protected by its root onRequest", async () => {
  const result = await analyze({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
    }),
    "src/routes/adapter.plugin.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "export const adapterPlugin = new Elysia().derive({ as: 'scoped' }, ({ params }) => {",
      "  if (!params.dbType) throw new Error('Invalid database type');",
      "  return { dbType: params.dbType };",
      "});",
    ),
    "src/routes/query.routes.ts": lines(
      'import { Elysia } from "elysia";',
      'import { z } from "zod";',
      'import { adapterPlugin } from "@/routes/adapter.plugin.js";',
      "",
      "export const queryRoutes = new Elysia({ prefix: '/query' })",
      "  .use(adapterPlugin)",
      "  .post('/', ({ body }) => body, { body: z.object({ query: z.string() }) });",
    ),
    "src/routes/telemetry.routes.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "export const telemetryRoutes = new Elysia({ prefix: '/telemetry' })",
      "  .put('/preference', ({ body }) => body);",
    ),
    "src/utils/create-server.ts": lines(
      'import { timingSafeEqual } from "node:crypto";',
      'import { Elysia } from "elysia";',
      'import { queryRoutes } from "@/routes/query.routes.js";',
      'import { telemetryRoutes } from "@/routes/telemetry.routes.js";',
      "",
      "const { API_PREFIX } = { API_PREFIX: '/api' };",
      "",
      "const isAuthorized = (authorization: string | null): boolean => {",
      "  const password = process.env.DB_STUDIO_PASSWORD;",
      "  if (!password) return true;",
      "  if (!authorization?.startsWith('Basic ')) return false;",
      "  return timingSafeEqual(Buffer.from(authorization), Buffer.from(password));",
      "};",
      "",
      "export const createServer = () => {",
      "  const app = new Elysia()",
      "    .onRequest(({ request }) => {",
      "      if (request.method !== 'OPTIONS' && !isAuthorized(request.headers.get('authorization'))) {",
      "        return new Response('Authentication required', { status: 401 });",
      "      }",
      "    })",
      "    .onError(({ error }) => error)",
      "    .group(API_PREFIX, (api) =>",
      "      api.use(telemetryRoutes).group('/:dbType', (scoped) => scoped.use(queryRoutes)),",
      "    );",
      "  return { app };",
      "};",
    ),
  });
  assert.deepEqual(authMessages(result), []);
  assert.deepEqual(validationMessages(result), [
    "PUT /{API_PREFIX}/telemetry/preference reads the request body without a schema",
  ]);
  assert.equal(result.summary, "2 Elysia endpoints across 4 source files");
});

test("callbacks and plugins passed by reference, factory, or import() are followed", async () => {
  const result = await analyze({
    "src/plugins.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const requireUser = ({ user, status }) => { if (!user) return status(401); };",
      "export const admin = (app: Elysia) => app.delete('/users/:id', ({ params }) => params.id);",
      "export const rbac = (role: string) => (app: Elysia) => app.onBeforeHandle(requireUser);",
      "export function registerRoutes(app) {",
      "  return app.post('/registered', () => 'ok');",
      "}",
    ),
    "src/lazy.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "export default new Elysia().delete('/lazy/:id', ({ params }) => params.id);",
    ),
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      'import { admin, rbac, registerRoutes } from "./plugins";',
      "",
      "const requireUser = ({ user, status }) => { if (!user) return status(401); };",
      "",
      "new Elysia().onBeforeHandle(requireUser).group('/admin', admin);",
      "new Elysia().guard({ beforeHandle: requireUser }, admin).post('/after-guard', () => 'open');",
      "new Elysia().use(rbac('admin')).post('/rbac', () => 'closed');",
      "new Elysia().onBeforeHandle(requireUser).use(import('./lazy'));",
      "const app = new Elysia().onBeforeHandle(requireUser);",
      "registerRoutes(app);",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /after-guard has no recognizable auth check",
  ]);
});

test("chains through Elysia methods CodeDiag does not list", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "new Elysia().propagate().mapDerive(() => ({})).post('/x', () => 'open').onError(() => 'error');",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /x has no recognizable auth check",
  ]);
});

test("resolve in route options, ternaries, and set.status count as auth", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "new Elysia()",
      "  .post('/resolve', ({ user }) => user, {",
      "    resolve: ({ bearer, status }) => {",
      "      if (!bearer) return status(401);",
      "      return { user: bearer };",
      "    },",
      "  })",
      "  .post('/ternary', () => 'ok', {",
      "    beforeHandle: ({ user, status }) => (user ? undefined : status(401)),",
      "  })",
      "  .resolve(({ bearer, set }) => {",
      "    if (!bearer) {",
      "      set.status = 401;",
      "      return { error: 'Sign in first' };",
      "    }",
      "    return { token: bearer };",
      "  })",
      "  .post('/status', () => 'ok');",
    ),
  });
  assert.deepEqual(authMessages(result), []);
});

test("a macro defined by a function that returns itself does not overflow", async () => {
  const result = await analyze({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "",
      "const a: any = () => b;",
      "const b: any = () => a;",
      "new Elysia().macro(a).post('/x', () => 'open');",
    ),
  });
  assert.deepEqual(authMessages(result), [
    "POST /x has no recognizable auth check",
  ]);
});

test("reports a project without Elysia routes", async () => {
  const result = await analyze({
    "src/index.ts": "export const answer = 42;\n",
  });
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    ["no-elysia-routes"],
  );
  assert.equal(result.score, 0);
});

test("scan() runs the Elysia analyzer as API Health", async () => {
  const directory = createProject({
    "src/index.ts": lines(
      'import { Elysia } from "elysia";',
      "new Elysia().post('/items', ({ body }) => body).listen(3000);",
    ),
  });
  try {
    const result = await scan(directory, undefined, {
      interactive: false,
      audit: false,
      secretHistory: false,
    });
    assert.equal(result.stack.framework, "elysia");
    const api = result.analyzers.find(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.deepEqual(api?.issues.map((issue) => issue.rule).sort(), [
      "missing-elysia-auth",
      "missing-elysia-error-handler",
      "missing-elysia-validation",
      "missing-health-endpoint",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
