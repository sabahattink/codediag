import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scanner.js";

const AUTH_RULES = new Set([
  "missing-auth-check",
  "missing-auth-middleware",
  "missing-auth-hook",
  "missing-hono-auth-middleware",
  "missing-guard",
]);

/** Messages of auth findings from an API-only scan of the given files. */
async function authFindings(files: Record<string, string>): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-webhook-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const config = loadConfig(directory);
    const result = await scan(
      directory,
      {
        ...config,
        analyzers: {
          api: true,
          security: false,
          dependencies: false,
          testing: false,
          structure: false,
        },
      },
      { interactive: false, audit: false },
    );
    return result.analyzers
      .flatMap((analyzer) => analyzer.issues)
      .filter((issue) => AUTH_RULES.has(issue.rule))
      .map((issue) => issue.message)
      .sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Next.js route handlers that verify a webhook signature count as authenticated", async () => {
  const findings = await authFindings({
    "package.json": JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    "app/api/stripe/route.ts": [
      'import Stripe from "stripe";',
      "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);",
      "export async function POST(request: Request) {",
      '  const signature = request.headers.get("stripe-signature")!;',
      "  const event = stripe.webhooks.constructEvent(await request.text(), signature, process.env.WEBHOOK_SECRET!);",
      "  return Response.json({ received: event.id });",
      "}",
    ].join("\n"),
    "app/api/svix/route.ts": [
      'import { Webhook } from "svix";',
      "export async function POST(request: Request) {",
      "  const wh = new Webhook(process.env.WEBHOOK_SECRET!);",
      "  const event = wh.verify(await request.text(), Object.fromEntries(request.headers));",
      "  return Response.json(event);",
      "}",
    ].join("\n"),
    "app/api/hmac/route.ts": [
      'import { createHmac, timingSafeEqual } from "node:crypto";',
      "export async function POST(request: Request) {",
      "  const body = await request.text();",
      '  const expected = createHmac("sha256", process.env.SECRET!).update(body).digest();',
      '  const given = Buffer.from(request.headers.get("x-signature") ?? "", "hex");',
      "  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {",
      '    return new Response("bad signature", { status: 401 });',
      "  }",
      "  return Response.json(JSON.parse(body));",
      "}",
    ].join("\n"),
    "app/api/github/route.ts": [
      'import { verifyGithubSignature } from "../../../lib/github";',
      "export async function POST(request: Request) {",
      "  const body = await request.text();",
      "  await verifyGithubSignature(request, body);",
      "  return Response.json({ ok: true });",
      "}",
    ].join("\n"),
    "app/api/posts/route.ts": [
      "export async function POST(request: Request) {",
      "  return Response.json(await request.json());",
      "}",
    ].join("\n"),
  });
  assert.deepEqual(findings, [
    "POST /api/posts has no recognizable auth check",
  ]);
});

test("Express routes that verify a webhook signature, inline, in a named handler, or in middleware, count as authenticated", async () => {
  const findings = await authFindings({
    "package.json": JSON.stringify({ dependencies: { express: "^5.0.0" } }),
    "src/app.js": [
      'const express = require("express");',
      'const Stripe = require("stripe");',
      "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);",
      "const app = express();",
      'app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {',
      '  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.WEBHOOK_SECRET);',
      "  res.json({ received: event.id });",
      "});",
      "function handleGithub(req, res) {",
      "  if (!verifyGithubSignature(req)) return res.status(401).end();",
      "  res.json({ ok: true });",
      "}",
      'app.post("/webhooks/github", express.json(), handleGithub);',
      'app.post("/webhooks/slack", verifySlackSignature, (req, res) => res.json(req.body));',
      'app.post("/posts", (req, res) => res.json(req.body));',
      "app.listen(3000);",
    ].join("\n"),
  });
  assert.deepEqual(findings, [
    "POST /posts has no recognizable auth middleware",
  ]);
});

test("Fastify and Hono handlers that verify a webhook signature count as authenticated", async () => {
  const fastify = await authFindings({
    "package.json": JSON.stringify({ dependencies: { fastify: "^5.0.0" } }),
    "src/app.js": [
      'const fastify = require("fastify")();',
      'fastify.post("/webhooks/stripe", async (request, reply) => {',
      '  const event = stripe.webhooks.constructEvent(request.rawBody, request.headers["stripe-signature"], secret);',
      "  return { received: event.id };",
      "});",
      'fastify.post("/posts", async (request) => request.body);',
      "fastify.listen({ port: 3000 });",
    ].join("\n"),
  });
  assert.deepEqual(fastify, ["POST /posts has no recognizable auth hook"]);

  const hono = await authFindings({
    "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
    "src/index.ts": [
      'import { Hono } from "hono";',
      'import { Webhook } from "svix";',
      "const app = new Hono();",
      'app.post("/webhooks/svix", async (c) => {',
      "  const wh = new Webhook(process.env.WEBHOOK_SECRET!);",
      "  const event = wh.verify(await c.req.text(), c.req.header());",
      "  return c.json(event);",
      "});",
      'app.post("/posts", async (c) => c.json(await c.req.json()));',
      "export default app;",
    ].join("\n"),
  });
  assert.equal(hono.length, 1);
  assert.match(hono[0] ?? "", /^POST \/posts /);
});

test("NestJS handlers that verify a webhook signature need no guard", async () => {
  const findings = await authFindings({
    "package.json": JSON.stringify({
      dependencies: { "@nestjs/core": "^11.0.0", "@nestjs/common": "^11.0.0" },
    }),
    "src/webhooks.controller.ts": [
      'import { Controller, Headers, Post, Req } from "@nestjs/common";',
      'import Stripe from "stripe";',
      '@Controller("webhooks")',
      "export class WebhooksController {",
      "  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);",
      '  @Post("stripe")',
      '  handle(@Headers("stripe-signature") signature: string, @Req() req: { rawBody: Buffer }) {',
      "    const event = this.stripe.webhooks.constructEvent(req.rawBody, signature, process.env.WEBHOOK_SECRET!);",
      "    return { received: event.id };",
      "  }",
      '  @Post("posts")',
      "  create() {",
      "    return {};",
      "  }",
      "}",
    ].join("\n"),
  });
  assert.deepEqual(findings, ["POST /webhooks/posts has no auth guard"]);
});
