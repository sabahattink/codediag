import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeExpressApi } from "../src/analyzers/express-api.js";
import { scan } from "../src/scanner.js";

function createProject(source: string, extension = "ts"): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-express-"));
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "express-fixture",
      dependencies: { express: "^5.0.0" },
    }),
  );
  writeFileSync(join(directory, "src", `app.${extension}`), source);
  return directory;
}

test("Express analyzer recognizes protected and validated routes", async () => {
  const directory = createProject(`
    import express from "express";
    const app = express();
    const router = express.Router();
    const requireAuth = () => {};
    const validateBody = () => {};
    router.get("/health", (_req, res) => res.send("ok"));
    router.post("/users", requireAuth, validateBody, (_req, res) => res.sendStatus(201));
    app.use((error, _req, res, _next) => res.status(500).send(error.message));
  `);

  try {
    const result = await analyzeExpressApi(directory);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
    assert.match(result.summary, /^2 Express endpoints/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Express analyzer reports missing API safeguards with locations", async () => {
  const directory = createProject(
    `
      const express = require("express");
      const app = express();
      app.get("/items", (_req, res) => res.json([]));
      app.post("/items", (_req, res) => res.sendStatus(201));
    `,
    "js",
  );

  try {
    const result = await analyzeExpressApi(directory);
    assert.equal(result.score, 0);
    assert.deepEqual(
      result.issues.map((issue) => issue.rule),
      [
        "missing-auth-middleware",
        "missing-validation-middleware",
        "missing-error-middleware",
        "missing-health-endpoint",
      ],
    );
    assert.equal(result.issues[0]?.file, "src/app.js");
    assert.equal(typeof result.issues[0]?.line, "number");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Express analyzer does not treat handler internals as middleware", async () => {
  const directory = createProject(`
    import express from "express";
    const app = express();
    app.post("/users", (request, response) => {
      const authResult = request.headers.authorization;
      const validationResult = request.body;
      response.json({ authResult, validationResult });
    });
  `);

  try {
    const result = await analyzeExpressApi(directory);
    assert.deepEqual(
      result.issues.slice(0, 2).map((issue) => issue.rule),
      ["missing-auth-middleware", "missing-validation-middleware"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Express analyzer excludes routes declared only in test files", async () => {
  const directory = createProject(
    `
      const express = require("express");
      const app = express();
    `,
    "js",
  );
  writeFileSync(
    join(directory, "src", "app.test.js"),
    'router.get("/test-only", handler);',
  );

  try {
    const result = await analyzeExpressApi(directory);
    assert.equal(result.score, 0);
    assert.equal(result.issues[0]?.rule, "no-express-routes");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner runs API Health analysis for Express projects", async () => {
  const directory = createProject(
    `
      const express = require("express");
      const app = express();
      app.get("/healthz", (_req, res) => res.send("ok"));
      app.use((error, _req, res, _next) => res.status(500).send(error.message));
    `,
    "js",
  );

  try {
    const result = await scan(directory);
    assert.equal(result.stack.framework, "express");
    assert.equal(
      result.analyzers.filter((analyzer) => analyzer.name === "API Health")
        .length,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
