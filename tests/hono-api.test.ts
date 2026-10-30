import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeHonoApi } from "../src/analyzers/hono-api.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = { hono: "^4.6.0" },
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-hono-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "hono-fixture", dependencies }),
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
    return await analyzeHonoApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Result = Awaited<ReturnType<typeof analyze>>;

function authFindings(result: Result) {
  return result.issues
    .filter((issue) => issue.rule === "missing-hono-auth-middleware")
    .map(({ message, file, confidence }) => ({ message, file, confidence }));
}

function authMessages(result: Result): string[] {
  return authFindings(result).map((finding) => finding.message);
}

function validatorMessages(result: Result): string[] {
  return result.issues
    .filter((issue) => issue.rule === "missing-hono-validator")
    .map((issue) => issue.message);
}

test("detects Hono projects without overriding Next.js, NestJS, Fastify, or Express", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ hono: "^4.6.0" }, "hono"],
    [{ hono: "^4.6.0", "@hono/node-server": "^1.13.0" }, "hono"],
    [{ next: "^15.0.0", hono: "^4.6.0" }, "nextjs"],
    [{ "@nestjs/core": "^10.0.0", hono: "^4.6.0" }, "nestjs"],
    [{ fastify: "^5.0.0", hono: "^4.6.0" }, "fastify"],
    [{ express: "^5.0.0", hono: "^4.6.0" }, "express"],
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

test("Hono analyzer recognizes protected and validated routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { zValidator } from "@hono/zod-validator";',
      'import { Hono } from "hono";',
      'import { jwt } from "hono/jwt";',
      "const app = new Hono();",
      'app.get("/health", (c) => c.json({ status: "ok" }));',
      'app.post("/users", jwt({ secret, alg: "HS256" }), zValidator("json", userSchema), (c) => c.json(c.req.valid("json"), 201));',
      'app.onError((error, c) => c.json({ message: "Internal Server Error" }, 500));',
    ].join("\n"),
  });

  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
  assert.match(result.summary, /^2 Hono endpoints/);
});

test("Hono analyzer reports missing API safeguards with locations", async () => {
  const result = await analyze({
    "src/app.js": [
      'const { Hono } = require("hono");',
      "const app = new Hono();",
      'app.get("/items", (c) => c.json([]));',
      'app.post("/items", async (c) => c.json(await c.req.json()));',
    ].join("\n"),
  });

  assert.equal(result.score, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    [
      "missing-hono-auth-middleware",
      "missing-hono-validator",
      "missing-hono-error-handler",
      "missing-health-endpoint",
    ],
  );
  assert.deepEqual(
    result.issues.slice(0, 3).map(({ message, file, line, confidence }) => ({
      message,
      file,
      line,
      confidence,
    })),
    [
      {
        message: "POST /items has no recognizable auth middleware",
        file: "src/app.js",
        line: 4,
        confidence: "high",
      },
      {
        message: "POST /items has no json or form validator",
        file: "src/app.js",
        line: 4,
        confidence: "high",
      },
      {
        message: "No Hono error handler is registered with onError()",
        file: undefined,
        line: undefined,
        confidence: undefined,
      },
    ],
  );
});

test("handler internals are not treated as middleware", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "const app = new Hono();",
      'app.post("/users", async (c) => {',
      '  const authorization = c.req.header("Authorization");',
      "  const user = userSchema.parse(await c.req.json());",
      "  return c.json({ authorization, user });",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues.slice(0, 2).map((issue) => issue.rule),
    ["missing-hono-auth-middleware", "missing-hono-validator"],
  );
});

test("basePath() and chained routes report full paths and their own lines", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "type Env = { Bindings: { DB: unknown } };",
      'const api = new Hono<Env>().basePath("/api");',
      "api",
      '  .get("/books", listBooks)',
      '  .post("/books", createBook);',
      'const v2 = api.basePath("/v2");',
      'v2.delete("/books/:id", removeBook);',
      'api.get("/authors/:id", readAuthor).put(updateAuthor);',
      'new Hono().basePath("/admin").patch("/flags", setFlags);',
    ].join("\n"),
  });

  assert.match(result.summary, /^6 Hono endpoints/);
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "missing-hono-auth-middleware")
      .map(({ message, line }) => ({ message, line })),
    [
      {
        message: "POST /api/books has no recognizable auth middleware",
        line: 6,
      },
      {
        message: "DELETE /api/v2/books/:id has no recognizable auth middleware",
        line: 8,
      },
      {
        message: "PUT /api/authors/:id has no recognizable auth middleware",
        line: 9,
      },
      {
        message: "PATCH /admin/flags has no recognizable auth middleware",
        line: 10,
      },
    ],
  );
});

test("app.route() sub-apps from other files get their prefix and earlier middleware", async () => {
  const result = await analyze({
    "src/routes/books.ts": [
      'import { zValidator } from "@hono/zod-validator";',
      'import { Hono } from "hono";',
      "const books = new Hono();",
      'books.get("/", listBooks);',
      'books.post("/", zValidator("json", bookSchema), createBook);',
      'books.delete("/:id", removeBook);',
      "export default books;",
    ].join("\n"),
    "src/routes/admin.ts": [
      'import { Hono } from "hono";',
      "export const admin = new Hono();",
      'admin.delete("/cache", clearCache);',
    ].join("\n"),
    "src/routes/webhooks.js": [
      'const { Hono } = require("hono");',
      "const hooks = new Hono();",
      'hooks.post("/stripe", handleStripe);',
      "module.exports = hooks;",
    ].join("\n"),
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { bearerAuth } from "hono/bearer-auth";',
      'import { jwt } from "hono/jwt";',
      'import { admin } from "./routes/admin.js";',
      'import books from "./routes/books";',
      'import webhooks from "./routes/webhooks.js";',
      "const app = new Hono();",
      'app.route("/webhooks", webhooks);',
      'app.use("/api/*", jwt({ secret, alg: "HS256" }));',
      'app.route("/api/books", books);',
      'app.route("/admin", admin);',
      'app.use("/admin/*", bearerAuth({ token }));',
    ].join("\n"),
  });

  assert.match(result.summary, /^5 Hono endpoints/);
  assert.deepEqual(authFindings(result), [
    {
      message: "DELETE /admin/cache has no recognizable auth middleware",
      file: "src/routes/admin.ts",
      confidence: "high",
    },
    {
      message: "POST /webhooks/stripe has no recognizable auth middleware",
      file: "src/routes/webhooks.js",
      confidence: "high",
    },
  ]);
  assert.deepEqual(validatorMessages(result), [
    "POST /webhooks/stripe has no json or form validator",
  ]);
});

test("app.use() applies only to later routes whose path it matches", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { basicAuth } from "hono/basic-auth";',
      "const app = new Hono();",
      'app.delete("/sessions", endSession);',
      'app.use("/posts/*", basicAuth({ username, password }));',
      'app.use("/users/:id/*", requireAuth);',
      'app.use("/login", authenticate);',
      'app.post("/posts", createPost);',
      'app.put("/posts/:id", updatePost);',
      'app.post("/postscript", runScript);',
      'app.put("/users/:id/avatar", setAvatar);',
      'app.delete("/users/:id", removeUser);',
      'app.delete("/users", removeUsers);',
      'app.post("/login", logIn);',
      'app.post("/login/reset", resetLogin);',
      "const shop = new Hono();",
      'shop.delete("/carts", clearCarts);',
      "shop.use(bearerAuthenticator);",
      'shop.delete("/orders", clearOrders);',
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "DELETE /sessions has no recognizable auth middleware",
    "POST /postscript has no recognizable auth middleware",
    "DELETE /users has no recognizable auth middleware",
    "POST /login/reset has no recognizable auth middleware",
    "DELETE /carts has no recognizable auth middleware",
  ]);
});

test("sub-app middleware also reaches later parent routes inside its prefix", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { jwt } from "hono/jwt";',
      "const account = new Hono();",
      'account.use(jwt({ secret, alg: "HS256" }));',
      'account.patch("/profile", updateProfile);',
      "const app = new Hono();",
      'app.route("/account", account);',
      'app.delete("/account/data", eraseData);',
      'app.delete("/accounting", closeBooks);',
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "DELETE /accounting has no recognizable auth middleware",
  ]);
});

test("a sub-app mounted in several places is protected only if every mount protects it", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { jwt } from "hono/jwt";',
      "const notes = new Hono();",
      'notes.delete("/:id", removeNote);',
      "const app = new Hono();",
      'app.use("/v2/*", jwt({ secret, alg: "HS256" }));',
      'app.route("/v2/notes", notes);',
      'app.route("/v1/notes", notes);',
    ].join("\n"),
  });

  assert.match(result.summary, /^1 Hono endpoints/);
  assert.deepEqual(authMessages(result), [
    "DELETE /v1/notes/:id has no recognizable auth middleware",
  ]);
});

test("Hono and third-party auth middleware are recognized by import", async () => {
  const result = await analyze({
    "src/middleware/auth.ts": [
      'import { createMiddleware } from "hono/factory";',
      "export const requireAdmin = createMiddleware(async (c, next) => {",
      '  if (c.get("jwtPayload")?.role !== "admin") return c.json({ message: "Forbidden" }, 403);',
      "  await next();",
      "});",
    ].join("\n"),
    "src/app.ts": [
      'import { initAuthConfig, verifyAuth } from "@hono/auth-js";',
      'import { clerkMiddleware } from "@hono/clerk-auth";',
      'import { Hono } from "hono";',
      'import { jwk as verifyKeys } from "hono/jwk";',
      'import { jwt } from "hono/jwt";',
      'import { requireAdmin } from "./middleware/auth.js";',
      "const app = new Hono();",
      'const guard = jwt({ secret, alg: "HS256" });',
      'app.delete("/a", verifyKeys({ jwks_uri }), removeA);',
      'app.delete("/b", clerkMiddleware(), removeB);',
      'app.delete("/c", verifyAuth(), removeC);',
      'app.delete("/d", requireAdmin, removeD);',
      'app.delete("/e", guard, removeE);',
      'app.delete("/f", initAuthConfig(getAuthConfig), removeF);',
      "const authConfig = initAuthConfig(getAuthConfig);",
      'app.delete("/g", authConfig, removeG);',
      'app.delete("/h", async (c, next) => {',
      '  const token = c.req.header("x-api-key");',
      '  if (token !== c.env.API_KEY) return c.text("Unauthorized", 401);',
      "  await next();",
      "}, removeH);",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "DELETE /f has no recognizable auth middleware",
    "DELETE /g has no recognizable auth middleware",
  ]);
});

test("body validators must target json or form", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { arktypeValidator } from "@hono/arktype-validator";',
      'import { sValidator } from "@hono/standard-validator";',
      'import { tbValidator } from "@hono/typebox-validator";',
      'import { vValidator } from "@hono/valibot-validator";',
      'import { zValidator } from "@hono/zod-validator";',
      'import { Hono } from "hono";',
      'import { validator } from "hono/validator";',
      "const app = new Hono();",
      'const validateId = zValidator("param", idSchema);',
      'app.post("/a", zValidator("json", schema), handleA);',
      'app.post("/b", vValidator("form", schema), handleB);',
      'app.post("/c", tbValidator("json", schema), handleC);',
      'app.post("/d", sValidator("json", schema), handleD);',
      'app.post("/e", arktypeValidator("json", schema), handleE);',
      'app.post("/f", validator("form", (value, c) => parseForm(value, c)), handleF);',
      'app.patch("/g/:id", validateId, handleG);',
      'app.put("/h/:id", zValidator("param", idSchema), zValidator("query", querySchema), handleH);',
      'app.put("/i", zValidator(target, schema), handleI);',
      'app.put("/j", validateBody, handleJ);',
      'app.post("/k", ...factory.createHandlers(zValidator("json", schema), handleK));',
      'app.post("/l", ...factory.createHandlers(handleL));',
    ].join("\n"),
  });

  assert.deepEqual(validatorMessages(result), [
    "PATCH /g/:id has no json or form validator",
    "PUT /h/:id has no json or form validator",
    "POST /l has no json or form validator",
  ]);
});

test("@hono/zod-openapi routes use the request body and middleware of createRoute()", async () => {
  const result = await analyze({
    "src/routes/users.ts": [
      'import { createRoute, z } from "@hono/zod-openapi";',
      "export const createUser = createRoute({",
      '  method: "post",',
      '  path: "/users",',
      "  middleware: [bearerAuth({ token })] as const,",
      "  request: { body: { content: { 'application/json': { schema: UserSchema } } } },",
      "  responses: { 201: { description: 'Created' } },",
      "});",
    ].join("\n"),
    "src/app.ts": [
      'import { createRoute, OpenAPIHono } from "@hono/zod-openapi";',
      'import { createUser } from "./routes/users.js";',
      "const app = new OpenAPIHono();",
      "app.openapi(createUser, (c) => c.json(c.req.valid('json'), 201));",
      "const renameUser = createRoute({",
      '  method: "put",',
      '  path: "/users/{id}",',
      "  request: { params: ParamsSchema },",
      "  responses: { 200: { description: 'Renamed' } },",
      "});",
      "app.openapi(renameUser, (c) => c.json({ ok: true }));",
    ].join("\n"),
  });

  assert.match(result.summary, /^2 Hono endpoints/);
  assert.deepEqual(authMessages(result), [
    "PUT /users/:id has no recognizable auth middleware",
  ]);
  assert.deepEqual(validatorMessages(result), [
    "PUT /users/:id has no json or form validator",
  ]);
});

test("onError() on any app counts, onError() on other objects does not", async () => {
  const withSubAppHandler = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "const status = new Hono();",
      'status.get("/healthz", (c) => c.text("ok"));',
      "status.onError((error, c) => c.json({ message: 'Unavailable' }, 503));",
      "const app = new Hono();",
      'app.route("/status", status);',
    ].join("\n"),
  });
  const withSocketHandler = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "const app = new Hono();",
      'app.get("/health", (c) => c.text("ok"));',
      "socket.onError((error) => reconnect(error));",
    ].join("\n"),
  });

  assert.equal(withSubAppHandler.score, 100);
  assert.deepEqual(withSubAppHandler.issues, []);
  assert.deepEqual(
    withSocketHandler.issues.map((issue) => issue.rule),
    ["missing-hono-error-handler"],
  );
});

test("health endpoints are found under sub-app prefixes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "const probes = new Hono().get('/ready', (c) => c.text('ok'));",
      "const app = new Hono().route('/probes', probes).onError(handleError);",
    ].join("\n"),
  });

  assert.deepEqual(result.issues, []);
});

test("functions taking a Hono parameter inherit the caller's middleware", async () => {
  const result = await analyze({
    "src/routes/users.ts": [
      'import type { Hono } from "hono";',
      "export function registerUsers(app: Hono): void {",
      '  app.post("/users", createUser);',
      "}",
      "export const registerJobs = (router: Hono) => {",
      '  router.post("/jobs", runJob);',
      "};",
    ].join("\n"),
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { jwt } from "hono/jwt";',
      'import { registerUsers } from "./routes/users.js";',
      "function createApp() {",
      "  const app = new Hono();",
      '  app.use("*", jwt({ secret, alg: "HS256" }));',
      "  return app;",
      "}",
      "const app = createApp();",
      'registerUsers(app.basePath("/v1"));',
      'app.delete("/v1/users/:id", removeUser);',
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "POST /jobs has no recognizable auth middleware",
      file: "src/routes/users.ts",
      confidence: "high",
    },
  ]);
  assert.deepEqual(validatorMessages(result), [
    "POST /v1/users has no json or form validator",
    "POST /jobs has no json or form validator",
  ]);
});

test("routes found only by receiver name are low-confidence findings", async () => {
  const result = await analyze({
    "src/routes.js": [
      "export default function register(app) {",
      '  app.post("/jobs", runJob);',
      "}",
    ].join("\n"),
    "src/server.ts": [
      "export class Server {",
      "  start() {",
      '    this.app.delete("/jobs/:id", cancelJob);',
      "  }",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "POST /jobs has no recognizable auth middleware",
      file: "src/routes.js",
      confidence: "low",
    },
    {
      message: "DELETE /jobs/:id has no recognizable auth middleware",
      file: "src/server.ts",
      confidence: "low",
    },
  ]);
});

test("HTTP clients, test requests, and calls without a handler are not routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      'import { hc } from "hono/client";',
      'import ky from "ky";',
      "const app = new Hono();",
      'const api = ky.create({ prefixUrl: "https://example.com" });',
      'const client = hc<AppType>("http://localhost:3000");',
      'app.get("/health", (c) => c.text("ok"));',
      'app.get("/profile");',
      'export const sync = () => api.post("users", { json: { name: "a" } });',
      "export const call = () => client.users.$post({ json: { name: 'a' } });",
      'export const ping = () => app.request("/health", { method: "POST" });',
    ].join("\n"),
  });

  assert.match(result.summary, /^1 Hono endpoints/);
  assert.deepEqual(authFindings(result), []);
});

test("Hono analyzer excludes routes declared only in test files", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Hono } from "hono";',
      "const app = new Hono();",
    ].join("\n"),
    "src/app.test.ts": 'app.post("/test-only", handler);',
  });

  assert.equal(result.score, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    ["no-hono-routes"],
  );
  assert.equal(
    result.issues[0]?.message,
    "No Hono route registrations were detected",
  );
});

test("scanner runs API Health analysis for Hono projects", async () => {
  const directory = createProject({
    "src/index.ts": [
      'import { Hono } from "hono";',
      "const app = new Hono();",
      'app.get("/healthz", (c) => c.text("ok"));',
      "app.onError((error, c) => c.text('Internal Server Error', 500));",
      "export default app;",
    ].join("\n"),
  });

  try {
    const result = await scan(directory, undefined, { interactive: false });
    assert.equal(result.stack.framework, "hono");
    const api = result.analyzers.filter(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.equal(api.length, 1);
    assert.match(api[0]?.summary ?? "", /^1 Hono endpoints/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
