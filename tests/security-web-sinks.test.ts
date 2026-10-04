import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

const WEB_RULES = new Set([
  "path-traversal",
  "server-side-request-forgery",
  "open-redirect",
  "reflected-xss",
]);

/** Each web-sink finding as [rule, severity, trimmed source line]. */
async function findings(lines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-web-sinks-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "handler.ts"), lines.join("\n"));
    const issues = await analyzeSecuritySinks(createScanContext(directory));
    return issues
      .filter((issue) => WEB_RULES.has(issue.rule))
      .map((issue) => [
        issue.rule,
        issue.severity,
        lines[(issue.line ?? 0) - 1].trim(),
      ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("file paths from request data are path traversal", async () => {
  assert.deepEqual(
    await findings([
      'import fs from "node:fs";',
      'import { readFile } from "node:fs/promises";',
      'import * as path from "node:path";',
      "export async function download(req, res) {",
      "  await readFile(path.join(UPLOADS, req.params.name));",
      "  fs.createReadStream(`./files/${req.query.file}`);",
      "  await fs.promises.unlink(req.body.path);",
      '  require("fs").readFileSync(req.query.p);',
      "  const { report } = req.query;",
      "  res.sendFile(report);",
      "  res.download(path.resolve(DIR, req.params.id));",
      "}",
    ]),
    [
      [
        "path-traversal",
        "critical",
        "await readFile(path.join(UPLOADS, req.params.name));",
      ],
      [
        "path-traversal",
        "critical",
        "fs.createReadStream(`./files/${req.query.file}`);",
      ],
      [
        "path-traversal",
        "critical",
        "await fs.promises.unlink(req.body.path);",
      ],
      [
        "path-traversal",
        "critical",
        'require("fs").readFileSync(req.query.p);',
      ],
      ["path-traversal", "critical", "res.sendFile(report);"],
      [
        "path-traversal",
        "critical",
        "res.download(path.resolve(DIR, req.params.id));",
      ],
    ],
  );
});

test("sanitized, checked, or looked-up paths are not path traversal", async () => {
  assert.deepEqual(
    await findings([
      'import { readFile, readFileSync } from "node:fs";',
      'import path from "node:path";',
      "export async function download(req, res, repo, config) {",
      "  readFileSync(path.join(UPLOADS, path.basename(req.params.name)));",
      "  const full = path.resolve(ROOT, req.query.file);",
      '  if (!full.startsWith(ROOT + path.sep)) throw new Error("outside");',
      "  readFileSync(full);",
      "  res.sendFile(req.params.name, { root: PUBLIC_DIR });",
      "  readFileSync(await repo.pathFor(req.params.id));",
      "  readFileSync(config.templatePath);",
      "  readFileSync(req.file.path);",
      "  readFileSync(path.join(AVATARS, req.user.avatar));",
      "}",
    ]),
    [],
  );
});

test("request data that picks an outgoing host is SSRF", async () => {
  assert.deepEqual(
    await findings([
      'import axios from "axios";',
      'import http from "node:http";',
      "export async function proxy(req, res) {",
      "  await fetch(req.query.url);",
      "  await axios.get(`${req.body.host}/status`);",
      '  http.get("http://" + req.query.host + "/health");',
      "  await got({ url: req.query.target });",
      "  const target = req.query.callback;",
      "  await this.httpService.post(target, {});",
      "}",
      "export async function GET(request) {",
      '  const target = new URL(request.url).searchParams.get("url");',
      "  return fetch(target);",
      "}",
    ]),
    [
      ["server-side-request-forgery", "warning", "await fetch(req.query.url);"],
      [
        "server-side-request-forgery",
        "warning",
        "await axios.get(`${req.body.host}/status`);",
      ],
      [
        "server-side-request-forgery",
        "warning",
        'http.get("http://" + req.query.host + "/health");',
      ],
      [
        "server-side-request-forgery",
        "warning",
        "await got({ url: req.query.target });",
      ],
      [
        "server-side-request-forgery",
        "warning",
        "await this.httpService.post(target, {});",
      ],
      ["server-side-request-forgery", "warning", "return fetch(target);"],
    ],
  );
});

test("URLs with a fixed origin are not SSRF", async () => {
  assert.deepEqual(
    await findings([
      'import axios from "axios";',
      'const API = "https://api.example.com";',
      "export async function proxy(req, config) {",
      "  await fetch(`https://api.example.com/users/${req.params.id}`);",
      "  await fetch(`${API}/users/${req.params.id}`);",
      '  await axios.get(process.env.BASE_URL + "/search?q=" + req.query.q);',
      "  await fetch(config.webhookUrl);",
      "  await fetch(`https://api.example.com?q=${req.query.q}`);",
      "}",
    ]),
    [],
  );
});

test("redirects to request-chosen targets are open redirects", async () => {
  assert.deepEqual(
    await findings([
      'import { NextResponse } from "next/server";',
      "export function login(req, res) {",
      "  res.redirect(req.query.next);",
      "  res.redirect(302, req.body.returnTo);",
      '  res.redirect("/" + req.query.path);',
      "}",
      "export function GET(request) {",
      "  const { searchParams } = new URL(request.url);",
      '  return NextResponse.redirect(new URL(searchParams.get("next"), request.url));',
      "}",
    ]),
    [
      ["open-redirect", "warning", "res.redirect(req.query.next);"],
      ["open-redirect", "warning", "res.redirect(302, req.body.returnTo);"],
      ["open-redirect", "warning", 'res.redirect("/" + req.query.path);'],
      [
        "open-redirect",
        "warning",
        'return NextResponse.redirect(new URL(searchParams.get("next"), request.url));',
      ],
    ],
  );
});

test("same-site and encoded redirect targets are not open redirects", async () => {
  assert.deepEqual(
    await findings([
      "export function login(req, res) {",
      '  res.redirect("/orders/" + req.params.id);',
      "  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);",
      '  res.redirect("https://app.example.com/" + req.query.page);',
      '  res.redirect(req.session.returnTo ?? "/");',
      "}",
    ]),
    [],
  );
});

test("request data in HTML responses is reflected XSS", async () => {
  assert.deepEqual(
    await findings([
      "export function search(req, res) {",
      "  res.send(`<h1>Results for ${req.query.q}</h1>`);",
      '  res.status(404).send("Not found: " + req.params.slug);',
      "  const { name } = req.query;",
      "  res.write(name);",
      "  res.end(req.query.callback + '(' + data + ')');",
      "}",
      "export function GET(request) {",
      '  const name = new URL(request.url).searchParams.get("name");',
      '  return new Response(`<p>Hello ${name}</p>`, { headers: { "Content-Type": "text/html" } });',
      "}",
    ]),
    [
      [
        "reflected-xss",
        "critical",
        "res.send(`<h1>Results for ${req.query.q}</h1>`);",
      ],
      [
        "reflected-xss",
        "critical",
        'res.status(404).send("Not found: " + req.params.slug);',
      ],
      ["reflected-xss", "critical", "res.write(name);"],
      [
        "reflected-xss",
        "critical",
        "res.end(req.query.callback + '(' + data + ')');",
      ],
      [
        "reflected-xss",
        "critical",
        'return new Response(`<p>Hello ${name}</p>`, { headers: { "Content-Type": "text/html" } });',
      ],
    ],
  );
});

test("escaped, JSON, plain-text, and looked-up responses are not XSS", async () => {
  assert.deepEqual(
    await findings([
      "export async function search(req, res, db) {",
      "  res.json({ q: req.query.q });",
      "  res.send(`<p>${escapeHtml(req.query.q)}</p>`);",
      '  res.type("text/plain").send(req.query.q);',
      "  res.send(req.body);",
      "  const user = await db.find(req.params.id);",
      "  res.send(`<p>${user.name}</p>`);",
      "  res.send(`<p>${Number(req.query.page)}</p>`);",
      "  res.send(`<p>${cache.get(req.params.id)}</p>`);",
      "  const payload = req.body;",
      "  res.send(payload);",
      "  res.send(`<p>Signed in as ${req.user.name} via ${req.method}</p>`);",
      "}",
      "export function GET(request) {",
      '  const name = new URL(request.url).searchParams.get("name");',
      "  return new Response(`Hello ${name}`);",
      "}",
      "export function events(req, res) {",
      '  res.setHeader("Content-Type", "text/event-stream");',
      "  res.write(`data: ${req.query.channel}\\n\\n`);",
      "}",
      "export function hello(request, reply) {",
      "  reply.send(`Hello ${request.query.name}`);",
      "}",
    ]),
    [],
  );
});

test("NestJS @Query, @Param, @Body, and @Headers parameters are request data", async () => {
  assert.deepEqual(
    await findings([
      'import { readFile } from "node:fs/promises";',
      "export class FilesController {",
      "  constructor(private readonly httpService: HttpService) {}",
      '  @Get(":name") async read(@Param("name") name: string) {',
      '    return readFile(`uploads/${name}`, "utf-8");',
      "  }",
      '  @Post("hooks") test(@Body() dto: WebhookDto) {',
      "    return this.httpService.post(dto.url, {});",
      "  }",
      '  @Get("go") go(@Query("next") next: string, @Res() res: Response) {',
      "    res.redirect(next);",
      "  }",
      '  @Get("echo") echo(@Body() dto: EchoDto, @Res() res: Response) {',
      "    res.send(dto);",
      "  }",
      '  @Get(":id") find(@Param("id") id: string, svc: Service) {',
      "    return readFile(svc.pathFor(id));",
      "  }",
      "}",
    ]),
    [
      [
        "path-traversal",
        "critical",
        'return readFile(`uploads/${name}`, "utf-8");',
      ],
      [
        "server-side-request-forgery",
        "warning",
        "return this.httpService.post(dto.url, {});",
      ],
      ["open-redirect", "warning", "res.redirect(next);"],
    ],
  );
});
