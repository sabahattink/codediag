import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

/**
 * Request data kept in state rather than passed along: fields of a class,
 * constructor arguments, collections handed to callbacks, and module
 * variables.
 */
async function scan(files: Record<string, string[]>) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-state-"));
  try {
    for (const [name, lines] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.join("\n"));
    }
    return await analyzeSecuritySinks(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Each finding as rule, severity, `file:line`, and a non-high confidence. */
function located(
  issues: Awaited<ReturnType<typeof scan>>,
): Array<{ rule: string; severity: string; at: string; confidence?: string }> {
  return issues.map(({ rule, severity, file, line, confidence }) => ({
    rule,
    severity,
    at: `${file}:${line}`,
    ...(confidence ? { confidence } : {}),
  }));
}

test("request data stored on this by one method reaches a sink in another", async () => {
  const issues = await scan({
    "src/jobs/runner.ts": [
      'import { exec } from "node:child_process";',
      "export class Runner {",
      '  private command = "";',
      "  configure(req) {",
      "    this.command = req.body.command;",
      "  }",
      "  run() {",
      "    exec(this.command);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/jobs/runner.ts:8",
      confidence: "medium",
    },
  ]);
  assert.equal(
    issues[0]?.message,
    "Shell execution receives a non-literal command",
  );
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/jobs\/runner\.ts:5; avoid a shell/,
  );
});

test("a constructor that stores request data taints the fields its methods read", async () => {
  const issues = await scan({
    "src/exports/export-job.ts": [
      'import fs from "node:fs";',
      "export class ExportJob {",
      "  private readonly file: string;",
      "  constructor(req) {",
      "    this.file = req.query.file;",
      "  }",
      "  read() {",
      "    const reader = () => fs.readFileSync(this.file);",
      "    return reader();",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/exports/export-job.ts:8",
      confidence: "medium",
    },
  ]);
});

test("new with request data reaches fields set from constructor parameters", async () => {
  const issues = await scan({
    "src/lib/jobs.ts": [
      'import { exec } from "node:child_process";',
      'import { readFile } from "node:fs/promises";',
      "export class Archiver {",
      "  constructor(private readonly target: string) {}",
      "  pack() {",
      "    exec(`tar -czf backup.tgz ${this.target}`);",
      "  }",
      "}",
      "export class Preview {",
      "  private readonly path: string;",
      "  constructor(path: string) {",
      "    this.path = path;",
      "  }",
      "  load() {",
      "    return readFile(this.path);",
      "  }",
      "}",
    ],
    "src/routes.ts": [
      'import { Archiver, Preview } from "./lib/jobs";',
      'app.post("/backup", async (req, res) => {',
      "  new Archiver(req.body.target).pack();",
      "  const preview = new Preview(req.query.path);",
      "  res.json({ size: (await preview.load()).length });",
      "});",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/lib/jobs.ts:6",
      confidence: "medium",
    },
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/lib/jobs.ts:15",
      confidence: "medium",
    },
  ]);
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/routes\.ts:3; /,
  );
  assert.match(
    issues[1]?.fix ?? "",
    /^Request data reaches this call from src\/routes\.ts:4; /,
  );
});

test("new through a require() binding reaches a CommonJS class's fields", async () => {
  const issues = await scan({
    "src/services/runner.js": [
      'const { exec } = require("node:child_process");',
      "class Runner {",
      "  constructor(command) {",
      "    this.command = command;",
      "  }",
      "  run() {",
      "    exec(this.command);",
      "  }",
      "}",
      "module.exports = Runner;",
    ],
    "src/app.js": [
      'const Runner = require("./services/runner");',
      'app.post("/run", (req, res) => new Runner(req.body.command).run());',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/services/runner.js:7",
      confidence: "medium",
    },
  ]);
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/app\.js:2; /,
  );
});

test("a URL field is judged by the whole value stored or passed for it", async () => {
  const issues = await scan({
    "src/lib/clients.ts": [
      "export class ApiClient {",
      "  constructor(private readonly base: string) {}",
      "  get() {",
      "    return fetch(this.base);",
      "  }",
      "}",
      "export class Forwarder {",
      '  private target = "";',
      "  configure(req) {",
      "    this.target = req.query.url;",
      "  }",
      "  forward() {",
      "    return fetch(this.target);",
      "  }",
      "}",
    ],
    "src/routes.ts": [
      'import { ApiClient } from "./lib/clients";',
      'app.get("/u/:id", (req, res) => {',
      "  return new ApiClient(`https://api.example.com/users/${req.params.id}`).get();",
      "});",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      at: "src/lib/clients.ts:13",
      confidence: "medium",
    },
  ]);
});

test("constants, sanitized values, and overwritten fields on this stay clean", async () => {
  const issues = await scan({
    "src/lib/jobs.ts": [
      'import { exec } from "node:child_process";',
      'import fs from "node:fs";',
      'import { basename } from "node:path";',
      "export class Fixed {",
      "  private command: string;",
      "  constructor() {",
      '    this.command = "npm run build";',
      "  }",
      "  run() {",
      "    exec(this.command);",
      "  }",
      "}",
      "export class Avatars {",
      '  private name = "default.png";',
      "  select(req) {",
      "    this.name = basename(req.query.name);",
      "  }",
      "  read() {",
      "    return fs.readFileSync(this.name);",
      "  }",
      "}",
      "export class Reports {",
      '  private dir = "";',
      "  configure(req) {",
      "    this.dir = req.query.dir;",
      "  }",
      "  list() {",
      '    this.dir = "/srv/reports";',
      "    return fs.readdirSync(this.dir);",
      "  }",
      "  watch() {",
      "    setTimeout(function (this: { dir: string }) {",
      "      fs.readdirSync(this.dir);",
      "    }, 10);",
      "  }",
      "}",
      "export class Builder {",
      "  constructor(private readonly script: string) {}",
      "  build() {",
      "    exec(this.script);",
      "  }",
      "}",
      'new Builder("npm run build").build();',
    ],
    "src/lib/other.ts": [
      "export class Other {",
      '  private command = "";',
      "  set(req) {",
      "    this.command = req.body.command;",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/lib/jobs.ts:10",
    },
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/lib/jobs.ts:40",
    },
  ]);
});

test("elements of request collections reach sinks through array callbacks and for...of", async () => {
  const issues = await scan({
    "src/routes.ts": [
      'import { exec } from "node:child_process";',
      'import fs from "node:fs";',
      'app.post("/batch", async (req, res) => {',
      "  req.body.commands.forEach((command) => exec(command));",
      "  const files = req.body.files.map((file) => fs.readFileSync(file));",
      "  req.body.names.some(function (name) { return fs.unlinkSync(name); });",
      "  const size = req.body.logs.reduce((sum, log) => sum + fs.readFileSync(log).length, 0);",
      "  for (const url of req.body.urls) await fetch(url);",
      "  for (const { target } of req.body.links) res.redirect(target);",
      "  Promise.resolve(req.query.next).then((next) => res.redirect(next));",
      "  res.json({ files, size });",
      "});",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/routes.ts:4",
    },
    { rule: "path-traversal", severity: "critical", at: "src/routes.ts:5" },
    { rule: "path-traversal", severity: "critical", at: "src/routes.ts:6" },
    { rule: "path-traversal", severity: "critical", at: "src/routes.ts:7" },
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      at: "src/routes.ts:8",
    },
    { rule: "open-redirect", severity: "warning", at: "src/routes.ts:9" },
    { rule: "open-redirect", severity: "warning", at: "src/routes.ts:10" },
  ]);
});

test("callbacks over constants, sanitized elements, indexes, and accumulators stay clean", async () => {
  const issues = await scan({
    "src/routes.ts": [
      'import fs from "node:fs";',
      'import { basename } from "node:path";',
      'const ALLOWED = ["a.txt", "b.txt"];',
      'app.post("/batch", (req, res) => {',
      "  req.body.files.forEach((file) => fs.readFileSync(basename(file)));",
      "  ALLOWED.forEach((file) => fs.readFileSync(file));",
      "  for (const file of ALLOWED) fs.readFileSync(file);",
      "  req.body.files.forEach((file, index) => fs.readFileSync(`/tmp/${index}.txt`));",
      '  req.body.files.reduce((dir, file) => fs.readdirSync(dir), "/srv");',
      "  res.json({});",
      "});",
    ],
  });

  assert.deepEqual(located(issues), []);
});

test("a project function that calls back with request data taints the callback", async () => {
  const issues = await scan({
    "src/lib/batch.ts": [
      "export function eachName(names: string[], visit: (name: string) => void) {",
      "  for (const name of names) visit(name);",
      "}",
    ],
    "src/routes.ts": [
      'import fs from "node:fs";',
      'import { eachName } from "./lib/batch";',
      'app.post("/cleanup", (req, res) => {',
      "  eachName(req.body.names, (name) => fs.unlinkSync(name));",
      '  eachName(["cache.json"], (name) => fs.readFileSync(name));',
      "  res.json({});",
      "});",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/routes.ts:4",
      confidence: "medium",
    },
  ]);
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/routes\.ts:4; /,
  );
});

test("a module variable set from request data in a handler taints its readers", async () => {
  const issues = await scan({
    "src/app.ts": [
      'import { exec } from "node:child_process";',
      'let lastCommand = "";',
      'const DEFAULT_COMMAND = "uptime";',
      'app.post("/set", (req, res) => {',
      "  lastCommand = req.body.command;",
      "  res.json({});",
      "});",
      "export function replay() {",
      "  exec(lastCommand);",
      "}",
      "export function status() {",
      "  exec(DEFAULT_COMMAND);",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/app.ts:9",
    },
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/app.ts:12",
    },
  ]);
});
