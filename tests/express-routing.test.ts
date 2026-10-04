import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeExpressApi } from "../src/analyzers/express-api.js";
import { createScanContext } from "../src/core/scan-context.js";

async function analyze(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-express-routing-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { express: "^5.0.0" } }),
    );
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return await analyzeExpressApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function routeFindings(result: Awaited<ReturnType<typeof analyze>>) {
  return result.issues
    .filter((issue) => issue.rule.startsWith("missing-auth"))
    .map(({ message, file, confidence }) => ({ message, file, confidence }));
}

test("routers are recognized by how they are created, not by their name", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import express from "express";',
      "const userRoutes = express.Router();",
      'userRoutes.delete("/users/:id", (_req, res) => res.sendStatus(204));',
    ].join("\n"),
  });

  assert.deepEqual(routeFindings(result), [
    {
      message: "DELETE /users/:id has no recognizable auth middleware",
      file: "src/app.ts",
      confidence: "high",
    },
  ]);
});

test("router.use() protects only routes registered after it", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import { Router } from "express";',
      "const routes = Router();",
      'routes.post("/login", login);',
      "routes.use(requireAuth);",
      'routes.post("/orders", createOrder);',
      'routes.delete("/orders/:id", deleteOrder);',
    ].join("\n"),
  });

  assert.deepEqual(
    routeFindings(result).map((finding) => finding.message),
    ["POST /login has no recognizable auth middleware"],
  );
});

test("middleware on a mount protects routers imported from other files", async () => {
  const result = await analyze({
    "src/routes/users.ts": [
      'import { Router } from "express";',
      "const router = Router();",
      'router.post("/", validateUser, createUser);',
      "export default router;",
    ].join("\n"),
    "src/routes/admin.js": [
      'const express = require("express");',
      "const adminRouter = express.Router();",
      'adminRouter.delete("/cache", clearCache);',
      "module.exports = adminRouter;",
    ].join("\n"),
    "src/app.ts": [
      'import express from "express";',
      'import users from "./routes/users";',
      'const admin = require("./routes/admin");',
      "const app = express();",
      'app.use("/users", authenticate, users);',
      'app.use("/admin", admin);',
      'app.get("/health", (_req, res) => res.send("ok"));',
      "app.use((error, _req, res, _next) => res.sendStatus(500));",
    ].join("\n"),
  });

  assert.deepEqual(routeFindings(result), [
    {
      message: "DELETE /admin/cache has no recognizable auth middleware",
      file: "src/routes/admin.js",
      confidence: "high",
    },
  ]);
  assert.deepEqual(
    result.issues.map((issue) => issue.rule),
    ["missing-auth-middleware"],
  );
});

test("app-level middleware before a mount applies to the mounted router", async () => {
  const result = await analyze({
    "src/app.js": [
      'const express = require("express");',
      "const app = express();",
      "const api = express.Router();",
      'api.put("/profile", validateProfile, saveProfile);',
      "app.use(passport.authenticate('jwt'));",
      'app.use("/api", api);',
    ].join("\n"),
  });

  assert.deepEqual(routeFindings(result), []);
});

test("a router mounted once without auth stays unprotected", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import express, { Router } from "express";',
      "const app = express();",
      "const items = Router();",
      'items.post("/", validateItem, createItem);',
      'app.use("/v1/items", requireAuth, items);',
      'app.use("/legacy/items", items);',
    ].join("\n"),
  });

  assert.deepEqual(
    routeFindings(result).map((finding) => finding.message),
    ["POST / has no recognizable auth middleware"],
  );
});

test("route() chains and typed router parameters are recognized", async () => {
  const result = await analyze({
    "src/routes.ts": [
      'import type { Router } from "express";',
      "export function register(router: Router) {",
      '  router.route("/books").get(listBooks).post(validateBook, createBook);',
      "}",
    ].join("\n"),
  });

  assert.match(result.summary, /^2 Express endpoints/);
  assert.deepEqual(routeFindings(result), [
    {
      message: "POST /books has no recognizable auth middleware",
      file: "src/routes.ts",
      confidence: "high",
    },
  ]);
  assert.equal(
    result.issues.some(
      (issue) => issue.rule === "missing-validation-middleware",
    ),
    false,
  );
});

test("routes found only by receiver name are low-confidence findings", async () => {
  const result = await analyze({
    "src/server.ts": [
      "export class Server {",
      "  start() {",
      '    this.app.post("/jobs", runJob);',
      "  }",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(routeFindings(result), [
    {
      message: "POST /jobs has no recognizable auth middleware",
      file: "src/server.ts",
      confidence: "low",
    },
  ]);
});

test("declared non-router clients named like routers are not routes", async () => {
  const result = await analyze({
    "src/app.ts": [
      'import express from "express";',
      'import axios from "axios";',
      "const app = express();",
      'const api = axios.create({ baseURL: "https://example.com" });',
      'app.get("/health", (_req, res) => res.send("ok"));',
      'export const sync = () => api.post("/users", { name: "a" });',
    ].join("\n"),
  });

  assert.match(result.summary, /^1 Express endpoints/);
  assert.deepEqual(routeFindings(result), []);
});
