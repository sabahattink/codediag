import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

async function sinks(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-taint-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "handler.ts"), source);
    const issues = await analyzeSecuritySinks(createScanContext(directory));
    return issues.map(({ rule, severity, line }) => ({ rule, severity, line }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("request data assigned to a variable makes a shell command critical", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        "export function run(req, res) {",
        "  const cmd = req.query.cmd;",
        "  exec(cmd);",
        "}",
      ].join("\n"),
    ),
    [{ rule: "dynamic-command-execution", severity: "critical", line: 4 }],
  );
});

test("taint follows destructuring and up to three assignments", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { execSync } from "child_process";',
        "export function run(request) {",
        "  const { body } = request;",
        "  const a = body.command;",
        "  const b = a;",
        "  const c = b;",
        "  execSync(c);",
        "}",
      ].join("\n"),
    ),
    [{ rule: "dynamic-command-execution", severity: "critical", line: 7 }],
  );
});

test("reassignment from request data inside the function is tainted", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        "export function run(req, verbose) {",
        '  let cmd = "ls";',
        "  if (verbose) cmd = req.headers['x-command'];",
        "  exec(cmd);",
        "}",
      ].join("\n"),
    ),
    [{ rule: "dynamic-command-execution", severity: "critical", line: 5 }],
  );
});

test("values from other sources stay warnings", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        "export function run(config) {",
        "  const cmd = config.command;",
        "  exec(cmd);",
        '  const table = config.table; db.query("SELECT * FROM " + table);',
        "}",
      ].join("\n"),
    ),
    [
      { rule: "dynamic-command-execution", severity: "warning", line: 4 },
      { rule: "dynamic-sql-query", severity: "warning", line: 5 },
    ],
  );
});

test("tainted SQL is found regardless of the client's variable name", async () => {
  assert.deepEqual(
    await sinks(
      [
        "export async function find(req) {",
        "  const myDb = getDb();",
        "  const { id } = req.params;",
        '  const sql = "SELECT * FROM users WHERE id = " + id;',
        "  await myDb.query(sql);",
        "  await store.execute(`DELETE FROM sessions WHERE token = '${req.body.token}'`);",
        "}",
      ].join("\n"),
    ),
    [
      { rule: "dynamic-sql-query", severity: "critical", line: 5 },
      { rule: "dynamic-sql-query", severity: "critical", line: 6 },
    ],
  );
});

test("non-SQL template calls on unknown receivers are not SQL findings", async () => {
  assert.deepEqual(
    await sinks(
      [
        "export function lookup(req) {",
        "  return cache.query(`user-${req.params.id}`);",
        "}",
      ].join("\n"),
    ),
    [],
  );
});

test("Next.js route handler input is request data", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        "export async function POST(request) {",
        "  const payload = await request.json();",
        "  const name = new URL(request.url).searchParams.get('name');",
        "  exec(payload.command);",
        "  exec(`echo ${name}`);",
        "}",
      ].join("\n"),
    ),
    [
      { rule: "dynamic-command-execution", severity: "critical", line: 5 },
      { rule: "dynamic-command-execution", severity: "critical", line: 6 },
    ],
  );
});

test("tRPC procedure input is request data, even after validation", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        'import { readFile } from "node:fs/promises";',
        'import { z } from "zod";',
        'import { protectedProcedure, router } from "./trpc";',
        "export const files = router({",
        "  compress: protectedProcedure.input(z.string()).mutation(({ input }) => exec(`gzip ${input}`)),",
        "  read: protectedProcedure.input(z.object({ path: z.string() })).query((opts) => readFile(opts.input.path)),",
        "  peek: protectedProcedure.input(z.object({ url: z.string() })).query(({ input: { url } }) => fetch(url)),",
        "  head: protectedProcedure.query(async function (opts) { return readFile(opts['input']); }),",
        "});",
      ].join("\n"),
    ),
    [
      { rule: "dynamic-command-execution", severity: "critical", line: 6 },
      { rule: "path-traversal", severity: "critical", line: 7 },
      { rule: "server-side-request-forgery", severity: "warning", line: 8 },
      { rule: "path-traversal", severity: "critical", line: 9 },
    ],
  );
});

test("tRPC context values and input outside a resolver are not request data", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        'import { readFile } from "node:fs/promises";',
        'import { protectedProcedure } from "./trpc";',
        "export const report = protectedProcedure.mutation((opts) => readFile(opts.ctx.session.user.id));",
        "export const replay = (jobs) => jobs.map(({ input }) => exec(input));",
      ].join("\n"),
    ),
    [{ rule: "dynamic-command-execution", severity: "warning", line: 5 }],
  );
});

test("NestJS request decorators taint shell commands and SQL, parsing pipes do not", async () => {
  assert.deepEqual(
    await sinks(
      [
        'import { exec } from "node:child_process";',
        "export class ReportsController {",
        '  @Get(":name") run(@Param("name") name: string) {',
        "    exec(`report ${name}`);",
        "  }",
        "  @Post() export(@Body() dto: ExportDto) {",
        "    return this.db.query(`SELECT * FROM t WHERE c = '${dto.column}'`);",
        "  }",
        '  @Get(":id") find(@Param("id", ParseIntPipe) id: number) {',
        "    return this.db.query(`SELECT * FROM t WHERE id = ${id}`);",
        "  }",
        '  @Get() list(@Query("limit", new ParseIntPipe()) limit: number) {',
        "    exec(`list --limit ${limit}`);",
        "  }",
        "}",
      ].join("\n"),
    ),
    [
      { rule: "dynamic-command-execution", severity: "critical", line: 4 },
      { rule: "dynamic-sql-query", severity: "critical", line: 7 },
      { rule: "dynamic-sql-query", severity: "warning", line: 10 },
      { rule: "dynamic-command-execution", severity: "warning", line: 13 },
    ],
  );
});
