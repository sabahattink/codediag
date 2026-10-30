import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

/** Each finding as "severity rule file:line confidence". */
async function scan(files: Record<string, string[]>) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cross-file-"));
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

test("a helper's file path from a route's request data is path traversal", async () => {
  const issues = await scan({
    "src/lib/files.ts": [
      'import fs from "node:fs/promises";',
      'import * as path from "node:path";',
      'const UPLOADS = "/srv/uploads";',
      "export function readUpload(name: string) {",
      "  return fs.readFile(path.join(UPLOADS, name));",
      "}",
    ],
    "src/routes/files.ts": [
      'import { readUpload } from "../lib/files.js";',
      'app.get("/f", (req, res) => readUpload(req.query.name));',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/lib/files.ts:5",
      confidence: "medium",
    },
  ]);
  assert.equal(issues[0]?.message, "A file path is built from request data");
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/routes\/files\.ts:2; /,
  );
});

test("a shell command from a caller's request data becomes one critical finding", async () => {
  const issues = await scan({
    "src/run.js": [
      'const { exec } = require("node:child_process");',
      "function run(cmd) {",
      "  exec(cmd);",
      "}",
      'router.post("/x", auth, (req, res) => run(req.body.cmd));',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/run.js:3",
      confidence: "medium",
    },
  ]);
  assert.equal(
    issues[0]?.message,
    "Shell execution receives a non-literal command",
  );
});

test("helper parameters reach SQL, spawn, and every web sink", async () => {
  const issues = await scan({
    "src/lib/sinks.ts": [
      'import { spawn } from "node:child_process";',
      'import ejs from "ejs";',
      "export async function findUser(id: string) {",
      '  return db.query("SELECT * FROM users WHERE id = " + id);',
      "}",
      "export function list(dir: string) {",
      '  spawn("ls", [dir], { shell: true });',
      "}",
      "export function preview(url: string) {",
      "  return fetch(url);",
      "}",
      "export function back(res, target: string) {",
      "  res.redirect(target);",
      "}",
      "export function greet(res, name: string) {",
      "  res.send(`<h1>Hello ${name}</h1>`);",
      "}",
      "export function render(source: string) {",
      "  return ejs.render(source, {});",
      "}",
      "export function setPath(target, section: string, key: string, value) {",
      "  target[section][key] = value;",
      "}",
    ],
    "src/routes.ts": [
      'import * as sinks from "./lib/sinks";',
      'app.post("/all", (req, res) => {',
      "  sinks.findUser(req.params.id);",
      "  sinks.list(req.query.dir);",
      "  sinks.preview(req.query.url);",
      "  sinks.back(res, req.query.next);",
      "  sinks.greet(res, req.query.name);",
      "  sinks.render(req.body.template);",
      "  sinks.setPath(settings, req.body.section, req.body.key, req.body.value);",
      "});",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-sql-query",
      severity: "critical",
      at: "src/lib/sinks.ts:4",
      confidence: "medium",
    },
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/lib/sinks.ts:7",
      confidence: "medium",
    },
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      at: "src/lib/sinks.ts:10",
      confidence: "medium",
    },
    {
      rule: "open-redirect",
      severity: "warning",
      at: "src/lib/sinks.ts:13",
      confidence: "medium",
    },
    {
      rule: "reflected-xss",
      severity: "critical",
      at: "src/lib/sinks.ts:16",
      confidence: "medium",
    },
    {
      rule: "server-side-template-injection",
      severity: "critical",
      at: "src/lib/sinks.ts:19",
      confidence: "medium",
    },
    {
      rule: "prototype-pollution",
      severity: "critical",
      at: "src/lib/sinks.ts:22",
      confidence: "medium",
    },
  ]);
});

test("a caller's fixed origin, same-site path, or parsed object keeps a helper clean", async () => {
  const issues = await scan({
    "src/lib/http.ts": [
      "export function apiGet(url: string) {",
      "  return fetch(url);",
      "}",
      "export function back(res, target: string) {",
      "  res.redirect(target);",
      "}",
      "export function reply(res, data) {",
      "  res.send(data);",
      "}",
    ],
    "src/routes.ts": [
      'import { apiGet, back, reply } from "./lib/http";',
      'app.get("/u/:id", (req, res) => {',
      "  apiGet(`https://api.example.com/users/${req.params.id}`);",
      "  back(res, `/orders/${req.params.id}`);",
      "  reply(res, req.body);",
      "});",
    ],
  });

  assert.deepEqual(located(issues), []);
});

test("a helper that returns request data makes its result request data", async () => {
  const issues = await scan({
    "src/lib/input.ts": [
      "export function getName(req) {",
      "  return req.query.name;",
      "}",
      "export const pick = (q) => q.file;",
      "export function lookup(id) {",
      "  return db.find(id);",
      "}",
    ],
    "src/routes.ts": [
      'import fs from "node:fs";',
      'import { getName, lookup, pick } from "./lib/input";',
      'app.get("/a", (req, res) => {',
      "  fs.readFileSync(getName(req));",
      "  fs.readFileSync(pick(req.query));",
      "  fs.readFileSync(lookup(req.query.id));",
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
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/routes.ts:5",
      confidence: "medium",
    },
  ]);
});

test("a NestJS service method called through this.service receives request data", async () => {
  const issues = await scan({
    "src/files/files.service.ts": [
      'import { Injectable } from "@nestjs/common";',
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      "@Injectable()",
      "export class FilesService {",
      "  read(name: string) {",
      '    return readFile(join("/srv/files", name));',
      "  }",
      "}",
    ],
    "src/files/files.controller.ts": [
      'import { Body, Controller, Post } from "@nestjs/common";',
      'import { FilesService } from "./files.service";',
      "class ReadDto { name!: string; }",
      '@Controller("files")',
      "export class FilesController {",
      "  constructor(private readonly files: FilesService) {}",
      "  @Post()",
      "  read(@Body() dto: ReadDto) {",
      "    return this.files.read(dto.name);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/files/files.service.ts:7",
      confidence: "medium",
    },
  ]);
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/files\/files\.controller\.ts:9; /,
  );
});

test("a NestJS query parameter passed to a service decides its request URL", async () => {
  const issues = await scan({
    "src/preview/preview.service.ts": [
      "export class PreviewService {",
      "  load(url: string) {",
      "    return fetch(url);",
      "  }",
      "}",
    ],
    "src/preview/preview.controller.ts": [
      'import { Controller, Get, Query } from "@nestjs/common";',
      'import { PreviewService } from "./preview.service";',
      '@Controller("preview")',
      "export class PreviewController {",
      "  constructor(private readonly previews: PreviewService) {}",
      "  @Get()",
      '  show(@Query("url") url: string) {',
      "    return this.previews.load(url);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "server-side-request-forgery",
      severity: "warning",
      at: "src/preview/preview.service.ts:3",
      confidence: "medium",
    },
  ]);
});

test("a NestJS service injected through an interface token reaches its one implementation", async () => {
  const issues = await scan({
    "src/files/file-store.ts": [
      "export interface FileStore {",
      "  read(name: string): Promise<Buffer>;",
      "}",
      'export const FILE_STORE = Symbol("FILE_STORE");',
    ],
    "src/files/disk-file-store.ts": [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import type { FileStore } from "./file-store";',
      "export class DiskFileStore implements FileStore {",
      "  read(name: string) {",
      '    return readFile(join("/srv/files", name));',
      "  }",
      "}",
    ],
    "src/files/files.module.ts": [
      'import { Module } from "@nestjs/common";',
      'import { DiskFileStore } from "./disk-file-store";',
      'import { FILE_STORE } from "./file-store";',
      'import { FilesController } from "./files.controller";',
      "@Module({",
      "  controllers: [FilesController],",
      "  providers: [{ provide: FILE_STORE, useClass: DiskFileStore }],",
      "})",
      "export class FilesModule {}",
    ],
    "src/files/files.controller.ts": [
      'import { Controller, Get, Inject, Query } from "@nestjs/common";',
      'import { FILE_STORE, type FileStore } from "./file-store";',
      '@Controller("files")',
      "export class FilesController {",
      "  constructor(@Inject(FILE_STORE) private readonly store: FileStore) {}",
      "  @Get()",
      '  read(@Query("name") name: string) {',
      "    return this.store.read(name);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/files/disk-file-store.ts:6",
      confidence: "medium",
    },
  ]);
  assert.match(
    issues[0]?.fix ?? "",
    /^Request data reaches this call from src\/files\/files\.controller\.ts:8; /,
  );
});

test("injection tokens and abstract classes resolve through module providers", async () => {
  const issues = await scan({
    "src/reports/reports.repository.ts": [
      "export interface ReportsRepository {",
      "  find(id: string): unknown;",
      "}",
      "export abstract class AuditLog {",
      "  abstract record(entry: string): void;",
      "}",
    ],
    "src/reports/sql-reports.repository.ts": [
      "export class SqlReportsRepository {",
      "  constructor(private readonly db: { query(sql: string): unknown }) {}",
      "  find(id: string) {",
      "    return this.db.query(`SELECT * FROM reports WHERE id = ${id}`);",
      "  }",
      "}",
    ],
    "src/reports/shell-audit-log.ts": [
      'import { execSync } from "node:child_process";',
      "export class ShellAuditLog {",
      "  record(entry: string) {",
      "    execSync(`logger ${entry}`);",
      "  }",
      "}",
    ],
    "src/reports/reports.module.ts": [
      'import { Module } from "@nestjs/common";',
      'import { AuditLog } from "./reports.repository";',
      'import { ShellAuditLog } from "./shell-audit-log";',
      'import { SqlReportsRepository } from "./sql-reports.repository";',
      "@Module({",
      "  providers: [",
      '    { provide: "REPORTS", useClass: SqlReportsRepository },',
      "    { provide: AuditLog, useClass: ShellAuditLog },",
      "  ],",
      "})",
      "export class ReportsModule {}",
    ],
    "src/reports/reports.controller.ts": [
      'import { Controller, Get, Inject, Query } from "@nestjs/common";',
      'import { AuditLog, type ReportsRepository } from "./reports.repository";',
      "class ShowReportQuery { id!: string; }",
      '@Controller("reports")',
      "export class ReportsController {",
      "  constructor(",
      '    @Inject("REPORTS") private readonly reports: ReportsRepository,',
      "    private readonly audit: AuditLog,",
      "  ) {}",
      "  @Get()",
      "  show(@Query() query: ShowReportQuery) {",
      "    this.audit.record(query.id);",
      "    return this.reports.find(query.id);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "critical",
      at: "src/reports/shell-audit-log.ts:4",
      confidence: "medium",
    },
    {
      rule: "dynamic-sql-query",
      severity: "critical",
      at: "src/reports/sql-reports.repository.ts:4",
      confidence: "medium",
    },
  ]);
});

test("an interface with several implementations is not followed", async () => {
  const issues = await scan({
    "src/jobs/runner.ts": [
      'import { exec } from "node:child_process";',
      "export interface Runner {",
      "  run(command: string): void;",
      "}",
      "export class LocalRunner implements Runner {",
      "  run(command: string) {",
      "    exec(command);",
      "  }",
      "}",
      "export class RemoteRunner implements Runner {",
      "  run(command: string) {",
      "    exec(`ssh worker ${command}`);",
      "  }",
      "}",
    ],
    "src/jobs/jobs.controller.ts": [
      'import { Controller, Inject, Post, Query } from "@nestjs/common";',
      'import type { Runner } from "./runner";',
      "class StartJobQuery { command!: string; }",
      '@Controller("jobs")',
      "export class JobsController {",
      '  constructor(@Inject("RUNNER") private readonly runner: Runner) {}',
      "  @Post()",
      "  start(@Query() query: StartJobQuery) {",
      "    this.runner.run(query.command);",
      "  }",
      "}",
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/jobs/runner.ts:7",
    },
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/jobs/runner.ts:12",
    },
  ]);
});

test("request data is followed through two helpers but not three", async () => {
  const issues = await scan({
    "src/lib/chain.ts": [
      'import fs from "node:fs";',
      "export function two(name) {",
      "  fs.readFileSync(name);",
      "}",
      "export function one(name) {",
      "  two(name);",
      "}",
      "export function three(name) {",
      "  fs.unlinkSync(name);",
      "}",
      "export function middle(name) {",
      "  three(name);",
      "}",
      "export function outer(name) {",
      "  middle(name);",
      "}",
    ],
    "src/routes.ts": [
      'import { one, outer } from "./lib/chain";',
      'app.get("/a", (req, res) => one(req.query.name));',
      'app.get("/b", (req, res) => outer(req.query.name));',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/lib/chain.ts:3",
      confidence: "medium",
    },
  ]);
});

test("recursive helpers end without a stack overflow", async () => {
  const issues = await scan({
    "src/walk.ts": [
      'import fs from "node:fs";',
      "export function walk(dir: string, depth: number): void {",
      "  for (const entry of fs.readdirSync(dir)) walk(dir + '/' + entry, depth + 1);",
      "}",
      "export function ping(value: string): string {",
      "  return pong(value);",
      "}",
      "export function pong(value: string): string {",
      "  return ping(value);",
      "}",
      'app.get("/w", (req, res) => walk(req.query.dir, 0));',
      'app.get("/p", (req, res) => fs.readFileSync(ping(req.query.p)));',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "path-traversal",
      severity: "critical",
      at: "src/walk.ts:3",
      confidence: "medium",
    },
  ]);
});

test("a helper that sanitizes its parameter is not reported", async () => {
  const issues = await scan({
    "src/lib/files.ts": [
      'import fs from "node:fs";',
      'import { basename, join } from "node:path";',
      "export function readUpload(name: string) {",
      '  return fs.readFileSync(join("/srv/uploads", basename(name)));',
      "}",
      "export function safeName(name: string) {",
      "  return basename(name);",
      "}",
    ],
    "src/routes.ts": [
      'import fs from "node:fs";',
      'import { readUpload, safeName } from "./lib/files";',
      'app.get("/f", (req, res) => {',
      "  readUpload(req.query.name);",
      "  fs.readFileSync(safeName(req.query.name));",
      "});",
    ],
  });

  assert.deepEqual(located(issues), []);
});

test("a helper called only with constants is not upgraded", async () => {
  const issues = await scan({
    "src/lib/shell.ts": [
      'import { execSync } from "node:child_process";',
      "export function run(cmd: string) {",
      "  return execSync(cmd);",
      "}",
    ],
    "src/build.ts": [
      'import { run } from "./lib/shell";',
      'run("npm run build");',
      'app.get("/v", (req, res) => res.json({ version: run("git describe") }));',
    ],
  });

  assert.deepEqual(located(issues), [
    {
      rule: "dynamic-command-execution",
      severity: "warning",
      at: "src/lib/shell.ts:3",
    },
  ]);
});

test("callers in test files and functions in node_modules are not followed", async () => {
  const issues = await scan({
    "src/lib/files.ts": [
      'import fs from "node:fs";',
      "export function readUpload(name: string) {",
      "  return fs.readFileSync(name);",
      "}",
    ],
    "src/lib/files.test.ts": [
      'import { readUpload } from "./files";',
      'test("reads", (req) => readUpload(req.query.name));',
    ],
    "node_modules/helper/index.js": [
      "module.exports = function pass(q) { return q.file; };",
    ],
    "src/routes.ts": [
      'import fs from "node:fs";',
      'import pass from "helper";',
      'app.get("/f", (req, res) => fs.readFileSync(pass(req.query)));',
    ],
  });

  assert.deepEqual(located(issues), []);
});
