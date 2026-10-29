import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { discoverExpressRoutes } from "../src/discovery/express-routes.js";
import type { RouteInfo } from "../src/analyzers/api-common.js";

function discover(files: Record<string, string>, asyncErrorsHandled = false): RouteInfo[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  for (const [path, text] of Object.entries(files)) project.createSourceFile(path, text);
  return discoverExpressRoutes(project, "/", { asyncErrorsHandled });
}

function route(routes: readonly RouteInfo[], method: string, path: string): RouteInfo {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`${method} ${path} not found in ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  return found;
}

describe("discoverExpressRoutes", () => {
  it("finds app.<method>(path, handler) routes with file and line", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        "const app = express();",
        'app.get("/health", (req, res) => res.send("ok"));',
        'app.post("/users", (req, res) => { db.save(req.body); res.sendStatus(201); });',
      ].join("\n"),
    });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health", "POST /users"]);
    expect(route(routes, "POST", "/users")).toMatchObject({ file: "src/app.ts", line: 4, hasAuth: false, readsBody: true, hasValidation: false });
    expect(route(routes, "GET", "/health").readsBody).toBe(false);
  });

  it("ignores calls on objects that are not Express apps or routers", () => {
    const routes = discover({
      "/src/client.ts": [
        'import axios from "axios";',
        'import express from "express";',
        "const app = express();",
        "const cache = new Map();",
        'axios.post("/users", payload);',
        'cache.get("/users");',
        'app.get("env");',
      ].join("\n"),
    });
    expect(routes).toEqual([]);
  });

  it("recognises express.Router(), Router() and typed parameters", () => {
    const routes = discover({
      "/src/a.ts": 'import express from "express";\nconst r = express.Router();\nr.put("/a", (req, res) => res.end());',
      "/src/b.ts": 'import { Router } from "express";\nconst r = Router();\nr.patch("/b", (req, res) => res.end());',
      "/src/c.ts": 'import type { Express } from "express";\nexport function register(app: Express) {\n  app.delete("/c", (req, res) => res.end());\n}',
    });
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["DELETE /c", "PATCH /b", "PUT /a"]);
  });

  it("detects inline auth middleware, including passport.authenticate", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        "const app = express();",
        'app.delete("/users/:id", requireAuth, (req, res) => res.end());',
        'app.post("/token", passport.authenticate("jwt", { session: false }), (req, res) => res.end());',
        'app.put("/users/:id", (req, res) => res.end());',
      ].join("\n"),
    });
    expect(route(routes, "DELETE", "/users/:id").hasAuth).toBe(true);
    expect(route(routes, "POST", "/token").hasAuth).toBe(true);
    expect(route(routes, "PUT", "/users/:id").hasAuth).toBe(false);
  });

  it("applies router.use(auth) only to routes registered after it", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        "const app = express();",
        "app.use(passport.initialize());",
        'app.post("/before", (req, res) => res.end());',
        "app.use(authenticate);",
        'app.post("/after", (req, res) => res.end());',
      ].join("\n"),
    });
    expect(route(routes, "POST", "/before").hasAuth).toBe(false);
    expect(route(routes, "POST", "/after").hasAuth).toBe(true);
  });

  it("scopes path-prefixed auth middleware to matching routes", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        "const app = express();",
        'app.use("/admin", requireAuth);',
        'app.post("/admin/users", (req, res) => res.end());',
        'app.post("/administrators", (req, res) => res.end());',
        'app.post("/public", (req, res) => res.end());',
      ].join("\n"),
    });
    expect(route(routes, "POST", "/admin/users").hasAuth).toBe(true);
    expect(route(routes, "POST", "/administrators").hasAuth).toBe(false);
    expect(route(routes, "POST", "/public").hasAuth).toBe(false);
  });

  it("resolves routers mounted from other ES modules and prefixes their paths", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        'import usersRouter from "./routes/users";',
        'import { adminRouter } from "./routes/admin.js";',
        "const app = express();",
        'app.use("/api/users", usersRouter);',
        'app.use("/api/admin", requireAuth, adminRouter);',
      ].join("\n"),
      "/src/routes/users.ts": [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/", (req, res) => res.json([]));',
        'router.post("/:id/avatar", (req, res) => res.end());',
        "export default router;",
      ].join("\n"),
      "/src/routes/admin.ts": [
        'import { Router } from "express";',
        "export const adminRouter = Router();",
        'adminRouter.delete("/users/:id", (req, res) => res.end());',
      ].join("\n"),
    });
    expect(route(routes, "GET", "/api/users")).toMatchObject({ file: "src/routes/users.ts", line: 3 });
    expect(route(routes, "POST", "/api/users/:id/avatar").hasAuth).toBe(false);
    expect(route(routes, "DELETE", "/api/admin/users/:id").hasAuth).toBe(true);
  });

  it("resolves CommonJS require/module.exports in JavaScript files", () => {
    const routes = discover({
      "/src/app.js": [
        'const express = require("express");',
        'const ordersRouter = require("./routes/orders");',
        "const app = express();",
        "app.use(authMiddleware);",
        'app.use("/orders", ordersRouter);',
        'app.use("/inline", require("./routes/inline"));',
      ].join("\n"),
      "/src/routes/orders.js": [
        'const express = require("express");',
        "const router = express.Router();",
        'router.post("/", (req, res) => res.end());',
        "module.exports = router;",
      ].join("\n"),
      "/src/routes/inline.js": [
        'const { Router } = require("express");',
        "const router = Router();",
        'router.put("/x", (req, res) => res.end());',
        "module.exports = router;",
      ].join("\n"),
    });
    expect(route(routes, "POST", "/orders").hasAuth).toBe(true);
    expect(route(routes, "PUT", "/inline/x")).toMatchObject({ file: "src/routes/inline.js", hasAuth: true });
  });

  it("supports router.route(path) chains", () => {
    const routes = discover({
      "/src/items.ts": [
        'import { Router } from "express";',
        "const router = Router();",
        'router.route("/items").get(list).post(validate(itemSchema), (req, res) => res.json(req.body));',
      ].join("\n"),
    });
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /items", "POST /items"]);
    expect(route(routes, "POST", "/items")).toMatchObject({ hasValidation: true, readsBody: true });
  });

  it("detects validation middleware and schema parsing in the handler", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        'import { body } from "express-validator";',
        "const app = express();",
        'app.post("/a", body("email").isEmail(), (req, res) => res.json(req.body));',
        'app.post("/b", (req, res) => { const input = schema.parse(req.body); res.json(input); });',
        'app.post("/c", (req, res) => { const input = JSON.parse(req.body); res.json(input); });',
        'app.post("/d", ({ body }, res) => res.json(body));',
      ].join("\n"),
    });
    expect(route(routes, "POST", "/a").hasValidation).toBe(true);
    expect(route(routes, "POST", "/b").hasValidation).toBe(true);
    expect(route(routes, "POST", "/c").hasValidation).toBe(false);
    expect(route(routes, "POST", "/d")).toMatchObject({ readsBody: true, hasValidation: false });
  });

  it("follows handlers imported from controller modules", () => {
    const routes = discover({
      "/src/app.ts": [
        'import express from "express";',
        'import { createUser } from "./controllers/users";',
        'import * as posts from "./controllers/posts";',
        'import { missing } from "some-package";',
        "const app = express();",
        'app.post("/users", createUser);',
        'app.post("/posts", posts.create);',
        'app.post("/other", missing);',
      ].join("\n"),
      "/src/controllers/users.ts": "export async function createUser(req, res) {\n  try { res.json(await db.insert(req.body)); } catch (e) { res.status(500).end(); }\n}",
      "/src/controllers/posts.ts": "export const create = async (req, res) => {\n  const data = postSchema.parse(req.body);\n  res.json(await db.insert(data));\n};",
    });
    expect(route(routes, "POST", "/users")).toMatchObject({ readsBody: true, hasValidation: false, unhandledAsync: false });
    expect(route(routes, "POST", "/posts")).toMatchObject({ readsBody: true, hasValidation: true, unhandledAsync: true });
    expect(route(routes, "POST", "/other").readsBody).toBeNull();
  });

  it("flags async handlers without error handling unless wrapped or handled globally", () => {
    const files = {
      "/src/app.ts": [
        'import express from "express";',
        "const app = express();",
        'app.post("/a", async (req, res) => { res.json(await db.find()); });',
        'app.post("/b", asyncHandler(async (req, res) => { res.json(await db.find()); }));',
        'app.post("/c", async (req, res, next) => { db.find().then((r) => res.json(r)).catch(next); });',
        'app.post("/d", (req, res) => res.end());',
      ].join("\n"),
    };
    const routes = discover(files);
    expect(route(routes, "POST", "/a").unhandledAsync).toBe(true);
    expect(route(routes, "POST", "/b").unhandledAsync).toBe(false);
    expect(route(routes, "POST", "/c").unhandledAsync).toBe(false);
    expect(route(routes, "POST", "/d").unhandledAsync).toBe(false);
    expect(route(discover(files, true), "POST", "/a").unhandledAsync).toBe(false);
  });

  it("reports app.all routes with method ALL", () => {
    const routes = discover({
      "/src/app.ts": 'import express from "express";\nconst app = express();\napp.all("*", (req, res) => res.sendStatus(404));',
    });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /*"]);
  });

  it("survives circular mounts", () => {
    const routes = discover({
      "/src/a.ts": 'import { Router } from "express";\nimport b from "./b";\nconst a = Router();\na.use("/b", b);\na.get("/x", (req, res) => res.end());\nexport default a;',
      "/src/b.ts": 'import { Router } from "express";\nimport a from "./a";\nconst b = Router();\nb.use("/a", a);\nb.get("/y", (req, res) => res.end());\nexport default b;',
    });
    expect(routes).toHaveLength(2);
  });
});
