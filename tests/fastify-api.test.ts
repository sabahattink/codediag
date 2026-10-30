import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeFastifyApi } from "../src/analyzers/fastify-api.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = { fastify: "^5.0.0" },
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-fastify-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "fastify-fixture", dependencies }),
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
    return await analyzeFastifyApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Result = Awaited<ReturnType<typeof analyze>>;

function authFindings(result: Result) {
  return result.issues
    .filter((issue) => issue.rule === "missing-auth-hook")
    .map(({ message, file, confidence }) => ({ message, file, confidence }));
}

function schemaFindings(result: Result): string[] {
  return result.issues
    .filter((issue) => issue.rule === "missing-route-schema")
    .map((issue) => issue.message);
}

test("detects Fastify projects without overriding NestJS on the Fastify platform", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ fastify: "^5.0.0" }, "fastify"],
    [
      {
        "@nestjs/core": "^10.0.0",
        "@nestjs/platform-fastify": "^10.0.0",
        fastify: "^4.0.0",
      },
      "nestjs",
    ],
    [
      { express: "^5.0.0", "@fastify/express": "^4.0.0", fastify: "^5.0.0" },
      "fastify",
    ],
    [{ express: "^5.0.0" }, "express"],
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

test("Fastify analyzer recognizes protected and validated routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import Fastify from "fastify";',
      "const app = Fastify({ logger: true });",
      'const body = { type: "object", required: ["name"] };',
      'app.get("/health", async () => ({ status: "ok" }));',
      'app.post("/users", { onRequest: [app.authenticate], schema: { body } }, async (request, reply) => reply.code(201).send(request.body));',
      "app.setErrorHandler((error, _request, reply) => reply.code(500).send({ message: 'Internal Server Error' }));",
    ].join("\n"),
  });

  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
  assert.match(result.summary, /^2 Fastify endpoints/);
});

test("Fastify analyzer reports missing API safeguards with locations", async () => {
  const result = await analyze({
    "src/app.js": [
      'const fastify = require("fastify");',
      "const app = fastify();",
      'app.get("/items", async () => []);',
      'app.post("/items", async (request) => request.body);',
    ].join("\n"),
  });

  assert.equal(result.score, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    [
      "missing-auth-hook",
      "missing-route-schema",
      "missing-error-handler",
      "missing-health-endpoint",
    ],
  );
  assert.deepEqual(
    result.issues.slice(0, 2).map(({ message, file, line, confidence }) => ({
      message,
      file,
      line,
      confidence,
    })),
    [
      {
        message: "POST /items has no recognizable auth hook",
        file: "src/app.js",
        line: 4,
        confidence: "high",
      },
      {
        message: "POST /items has no request body schema",
        file: "src/app.js",
        line: 4,
        confidence: "high",
      },
    ],
  );
});

test("Fastify analyzer does not treat handler internals as hooks", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import Fastify from "fastify";',
      "const app = Fastify();",
      'app.post("/users", async (request) => {',
      "  const authorization = request.headers.authorization;",
      "  const validated = userSchema.parse(request.body);",
      "  return { authorization, validated };",
      "});",
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues.slice(0, 2).map((issue) => issue.rule),
    ["missing-auth-hook", "missing-route-schema"],
  );
});

test("route() declarations with method lists are analyzed per method", async () => {
  const result = await analyze({
    "src/server.ts": [
      'import { fastify } from "fastify";',
      "const server = fastify().withTypeProvider<ZodTypeProvider>();",
      "server.route({",
      '  method: ["POST", "PUT"],',
      '  url: "/orders",',
      "  preHandler: server.auth([server.verifyJwt]),",
      "  handler: saveOrder,",
      "});",
      'server.route({ method: "DELETE", url: "/orders/:id", handler: deleteOrder });',
      'server.route({ method: "GET", url: "/healthz", handler: () => "ok" });',
    ].join("\n"),
  });

  assert.match(result.summary, /^4 Fastify endpoints/);
  assert.deepEqual(authFindings(result), [
    {
      message: "DELETE /orders/:id has no recognizable auth hook",
      file: "src/server.ts",
      confidence: "high",
    },
  ]);
  assert.deepEqual(schemaFindings(result), [
    "POST /orders has no request body schema",
    "PUT /orders has no request body schema",
  ]);
});

test("addHook() protects every route of its plugin but not sibling plugins", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import Fastify, { type FastifyInstance } from "fastify";',
      "const app = Fastify();",
      "async function accountRoutes(fastify: FastifyInstance) {",
      '  fastify.post("/account", { schema: { body: AccountBody } }, updateAccount);',
      '  fastify.addHook("onRequest", fastify.authenticate);',
      "}",
      "async function publicRoutes(fastify: FastifyInstance) {",
      '  fastify.post("/signup", { schema: { body: SignupBody } }, signup);',
      "}",
      'app.register(accountRoutes, { prefix: "/me" });',
      "app.register(publicRoutes);",
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "POST /signup has no recognizable auth hook",
      file: "src/app.ts",
      confidence: "high",
    },
  ]);
});

test("hooks reach plugins registered from other files, with their prefixes", async () => {
  const result = await analyze({
    "src/routes/users.ts": [
      'import type { FastifyPluginAsync } from "fastify";',
      "const users: FastifyPluginAsync = async (fastify) => {",
      '  fastify.delete("/:id", removeUser);',
      "};",
      "export default users;",
    ].join("\n"),
    "src/routes/admin.js": [
      "module.exports = async function admin(fastify) {",
      '  fastify.delete("/cache", clearCache);',
      "};",
    ].join("\n"),
    "src/app.ts": [
      'import Fastify from "fastify";',
      'import admin from "./routes/admin.js";',
      'import users from "./routes/users.js";',
      "const app = Fastify();",
      "app.register(async (secured) => {",
      '  secured.addHook("preHandler", async (request) => {',
      "    await request.jwtVerify();",
      "  });",
      '  secured.register(users, { prefix: "/users" });',
      "});",
      'app.register(admin, { prefix: "/admin" });',
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "DELETE /admin/cache has no recognizable auth hook",
      file: "src/routes/admin.js",
      confidence: "high",
    },
  ]);
});

test("fastify-plugin hooks apply to the context that registers them", async () => {
  const result = await analyze({
    "src/plugins/auth.ts": [
      'import fp from "fastify-plugin";',
      "export default fp(async (fastify) => {",
      '  fastify.addHook("onRequest", async (request) => {',
      "    await request.jwtVerify();",
      "  });",
      "});",
    ].join("\n"),
    "src/plugins/scoped-auth.js": [
      "export default async function scopedAuth(fastify) {",
      '  fastify.addHook("onRequest", fastify.authenticate);',
      "}",
    ].join("\n"),
    "src/app.ts": [
      'import Fastify from "fastify";',
      'import bearerAuth from "@fastify/bearer-auth";',
      'import auth from "./plugins/auth.js";',
      'import scopedAuth from "./plugins/scoped-auth.js";',
      "const app = Fastify();",
      "const admin = Fastify();",
      "const internal = Fastify();",
      'app.delete("/sessions", endSession);',
      "app.register(auth);",
      "admin.register(scopedAuth);",
      'admin.delete("/sessions", endSession);',
      "internal.register(bearerAuth, { keys });",
      'internal.delete("/sessions", endSession);',
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "missing-auth-hook")
      .map(({ message, line }) => ({ message, line })),
    [{ message: "DELETE /sessions has no recognizable auth hook", line: 11 }],
  );
});

test("routes found only by receiver name are low-confidence findings", async () => {
  const result = await analyze({
    "src/routes.js": [
      "module.exports = async function (fastify) {",
      '  fastify.post("/jobs", runJob);',
      "};",
    ].join("\n"),
    "src/server.ts": [
      "export class Server {",
      "  start() {",
      '    this.server.delete("/jobs/:id", cancelJob);',
      "  }",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "POST /jobs has no recognizable auth hook",
      file: "src/routes.js",
      confidence: "low",
    },
    {
      message: "DELETE /jobs/:id has no recognizable auth hook",
      file: "src/server.ts",
      confidence: "low",
    },
  ]);
});

test("HTTP clients and calls without a handler are not routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import Fastify from "fastify";',
      'import got from "got";',
      "const app = Fastify();",
      'const server = got.extend({ prefixUrl: "https://example.com" });',
      'app.get("/health", async () => "ok");',
      'export const sync = () => server.post("/users", { json: { name: "a" } });',
      'export const ping = () => app.inject({ method: "POST", url: "/users" });',
    ].join("\n"),
  });

  assert.match(result.summary, /^1 Fastify endpoints/);
  assert.deepEqual(authFindings(result), []);
});

test("route schemas are resolved through variables and imports", async () => {
  const result = await analyze({
    "src/schemas.ts":
      'export const createUser = { body: { type: "object" }, response: {} };',
    "src/app.ts": [
      'import Fastify from "fastify";',
      'import { createUser } from "./schemas.js";',
      "const app = Fastify();",
      "const updateUser = { params: UserParams };",
      "const patchOptions = { onRequest: app.authenticate, preValidation: validateUser };",
      'app.post("/users", { onRequest: app.authenticate, schema: createUser }, create);',
      'app.put("/users/:id", { onRequest: app.authenticate, schema: updateUser }, update);',
      'app.patch("/users/:id", patchOptions, patch);',
      'app.post("/imports", { onRequest: app.authenticate, schema: buildSchema() }, importUsers);',
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), []);
  assert.deepEqual(schemaFindings(result), [
    "PUT /users/:id has no request body schema",
  ]);
});

test("inline and dynamically imported plugins contribute prefixed routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import Fastify from "fastify";',
      "const app = Fastify();",
      'app.register(import("./routes/status.js"), { prefix: "/status" });',
      "app.setErrorHandler(handleError);",
    ].join("\n"),
    "src/routes/status.ts": [
      'import type { FastifyInstance } from "fastify";',
      "export default async function (fastify: FastifyInstance) {",
      '  fastify.get("/health", async () => ({ ok: true }));',
      "}",
    ].join("\n"),
  });

  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
  assert.match(result.summary, /^1 Fastify endpoints/);
});

test("@fastify/autoload plugins get directory, auto, and option prefixes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import AutoLoad, { type AutoloadPluginOptions } from "@fastify/autoload";',
      'import type { FastifyPluginAsync } from "fastify";',
      'import { join } from "node:path";',
      "const app: FastifyPluginAsync<AutoloadPluginOptions> = async (fastify, opts) => {",
      "  fastify.setErrorHandler(handleError);",
      "  void fastify.register(AutoLoad, {",
      '    dir: join(__dirname, "plugins"),',
      "    options: opts,",
      "  });",
      "  void fastify.register(AutoLoad, {",
      '    dir: join(__dirname, "routes"),',
      '    options: { ...opts, prefix: "/api/" },',
      "  });",
      "};",
      "export default app;",
    ].join("\n"),
    "src/plugins/sensible.ts": [
      'import sensible from "@fastify/sensible";',
      'import fp from "fastify-plugin";',
      "export default fp(async (fastify) => {",
      "  await fastify.register(sensible);",
      "});",
    ].join("\n"),
    "src/routes/root.ts": [
      "export default async function (fastify) {",
      '  fastify.get("/", async () => ({ root: true }));',
      "}",
    ].join("\n"),
    "src/routes/health/index.ts": [
      "export default async (fastify) => {",
      '  fastify.get("/", async () => ({ status: "ok" }));',
      "};",
    ].join("\n"),
    "src/routes/users/index.ts": [
      "export default async (fastify) => {",
      '  fastify.delete("/:id", removeUser);',
      "};",
    ].join("\n"),
    // An index file replaces the other files of its directory, so this
    // shared hook is never loaded.
    "src/routes/users/handlers.ts": [
      'import fp from "fastify-plugin";',
      "export default fp(async (fastify) => {",
      '  fastify.addHook("onRequest", fastify.authenticate);',
      "});",
    ].join("\n"),
    "src/routes/admin/cache.ts": [
      'export const autoPrefix = "/internal";',
      "export default async function (fastify) {",
      '  fastify.delete("/cache", clearCache);',
      "}",
    ].join("\n"),
    "src/routes/legacy.js": [
      "module.exports = async function (fastify) {",
      '  fastify.post("/import", { schema: { body: ImportBody } }, runImport);',
      "};",
      'module.exports.prefixOverride = "/v1";',
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "DELETE /api/internal/cache has no recognizable auth hook",
      file: "src/routes/admin/cache.ts",
      confidence: "high",
    },
    {
      message: "POST /v1/import has no recognizable auth hook",
      file: "src/routes/legacy.js",
      confidence: "high",
    },
    {
      message: "DELETE /api/users/:id has no recognizable auth hook",
      file: "src/routes/users/index.ts",
      confidence: "high",
    },
  ]);
  assert.equal(
    result.issues.some((issue) => issue.rule === "missing-health-endpoint"),
    false,
  );
});

test("autoloaded fastify-plugin hooks protect routes from another autoload directory", async () => {
  const result = await analyze({
    "app.js": [
      "'use strict';",
      "const path = require('node:path');",
      "const AutoLoad = require('@fastify/autoload');",
      "module.exports = async function (fastify, opts) {",
      "  fastify.register(AutoLoad, {",
      "    dir: path.join(__dirname, 'plugins'),",
      "    options: Object.assign({}, opts),",
      "  });",
      "  fastify.register(AutoLoad, {",
      "    dir: path.join(__dirname, 'routes'),",
      "    options: Object.assign({}, opts),",
      "  });",
      "};",
    ].join("\n"),
    "plugins/auth.js": [
      "'use strict';",
      "const fp = require('fastify-plugin');",
      "module.exports = fp(async function (fastify) {",
      "  fastify.addHook('onRequest', async (request) => {",
      "    await request.jwtVerify();",
      "  });",
      "});",
    ].join("\n"),
    "routes/example/index.js": [
      "'use strict';",
      "module.exports = async function (fastify) {",
      "  fastify.delete('/', async () => ({ deleted: true }));",
      "};",
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), []);
  assert.match(result.summary, /^1 Fastify endpoints/);
});

test("autohooks protect their directory, and subdirectories only when cascaded", async () => {
  const project = (cascade: boolean) => ({
    "src/app.ts": [
      'import autoload from "@fastify/autoload";',
      'import Fastify from "fastify";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const __dirname = dirname(fileURLToPath(import.meta.url));",
      "const app = Fastify();",
      "app.register(autoload, {",
      '  dir: join(__dirname, "routes"),',
      "  autoHooks: true,",
      `  cascadeHooks: ${cascade},`,
      "});",
    ].join("\n"),
    "src/routes/admin/autohooks.ts": [
      "export default async function (fastify) {",
      '  fastify.addHook("onRequest", fastify.authenticate);',
      "}",
    ].join("\n"),
    "src/routes/admin/users.ts": [
      "export default async function (fastify) {",
      '  fastify.delete("/users/:id", removeUser);',
      "}",
    ].join("\n"),
    "src/routes/admin/reports/index.ts": [
      "export default async (fastify) => {",
      '  fastify.delete("/", clearReports);',
      "};",
    ].join("\n"),
    "src/routes/public.ts": [
      "export default async (fastify) => {",
      '  fastify.delete("/sessions", endSession);',
      "};",
    ].join("\n"),
  });

  const messages = (result: Result) =>
    authFindings(result).map((finding) => finding.message);
  assert.deepEqual(messages(await analyze(project(false))), [
    "DELETE /admin/reports has no recognizable auth hook",
    "DELETE /sessions has no recognizable auth hook",
  ]);
  assert.deepEqual(messages(await analyze(project(true))), [
    "DELETE /sessions has no recognizable auth hook",
  ]);
});

test("autoload directories resolve from import.meta and file URLs", async () => {
  const result = await analyze({
    "src/server.mjs": [
      'import autoload from "@fastify/autoload";',
      'import fastify from "fastify";',
      'import { join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const server = fastify();",
      "server.register(autoload, {",
      '  dir: fileURLToPath(new URL("./routes", import.meta.url)),',
      '  options: { prefix: "/a" },',
      "});",
      "server.register(autoload, {",
      '  dir: join(import.meta.dirname, "..", "extra"),',
      '  options: { prefix: "/b" },',
      "  dirNameRoutePrefix: false,",
      "});",
    ].join("\n"),
    "src/routes/x.mjs": [
      "export default async (app) => {",
      '  app.delete("/x", removeX);',
      "};",
    ].join("\n"),
    "extra/nested/y.mjs": [
      "export default async (app) => {",
      '  app.delete("/y", removeY);',
      "};",
    ].join("\n"),
  });

  assert.deepEqual(authFindings(result), [
    {
      message: "DELETE /b/y has no recognizable auth hook",
      file: "extra/nested/y.mjs",
      confidence: "high",
    },
    {
      message: "DELETE /a/x has no recognizable auth hook",
      file: "src/routes/x.mjs",
      confidence: "high",
    },
  ]);
});

test("Fastify analyzer excludes routes declared only in test files", async () => {
  const result = await analyze({
    "src/app.js": [
      'const fastify = require("fastify");',
      "const app = fastify();",
    ].join("\n"),
    "src/app.test.js": 'app.post("/test-only", handler);',
  });

  assert.equal(result.score, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    ["no-fastify-routes"],
  );
});

test("scanner runs API Health analysis for Fastify projects", async () => {
  const directory = createProject({
    "src/app.js": [
      'const fastify = require("fastify")({ logger: true });',
      'fastify.get("/healthz", async () => "ok");',
      "fastify.setErrorHandler((error, request, reply) => reply.send(error));",
    ].join("\n"),
  });

  try {
    const result = await scan(directory);
    assert.equal(result.stack.framework, "fastify");
    const api = result.analyzers.filter(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.equal(api.length, 1);
    assert.match(api[0]?.summary ?? "", /^1 Fastify endpoints/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
