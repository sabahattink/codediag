import { describe, it, expect, afterEach } from "vitest";
import { analyzeNestjsApi } from "../src/analyzers/nestjs-api.js";
import { analyzeExpressApi } from "../src/analyzers/express-api.js";
import { analyzeNextjsApi } from "../src/analyzers/nextjs-api.js";
import { isPublicByDesign, joinRoutePath } from "../src/analyzers/api-common.js";
import type { AnalyzerResult } from "../src/types.js";
import {
  EXPRESS_FIXTURE,
  NEST_FIXTURE,
  NEXT_FIXTURE,
  cleanupTempProjects,
  contextFor,
  copyFixture,
  tempProject,
  writeProjectFile,
} from "./helpers.js";

afterEach(cleanupTempProjects);

function issueList(result: AnalyzerResult | null, severity?: string): string[] {
  return (result?.issues ?? [])
    .filter((i) => !severity || i.severity === severity)
    .map((i) => `${i.rule} ${i.message} @${i.file}:${i.line}`);
}

describe("analyzeNestjsApi", () => {
  it("reports unguarded and untyped endpoints in the NestJS fixture", async () => {
    const result = await analyzeNestjsApi(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    expect(issueList(result, "warning")).toEqual([
      "missing-guard POST /posts has no auth guard @src/posts/posts.controller.ts:20",
      "missing-dto POST /posts has no typed DTO for request body @src/posts/posts.controller.ts:20",
      "missing-guard DELETE /posts/:id has no auth guard @src/posts/posts.controller.ts:26",
    ]);
    expect(result.summary).toBe("7 endpoints across 3 controllers");
    expect(result.score).toBe(64);
  });

  it("reads @Controller({ path }) and treats POST /auth/login as public by design", async () => {
    const result = await analyzeNestjsApi(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    const messages = result.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("PATCH /posts/:id");
    expect(messages).not.toContain("/auth/login has no auth guard");
    expect(messages).not.toContain("{");
  });

  it("treats every endpoint as guarded when a global guard is registered", async () => {
    const dir = copyFixture(NEST_FIXTURE);
    writeProjectFile(dir, "src/guards.provider.ts", 'import { APP_GUARD } from "@nestjs/core";\nexport const guards = [{ provide: APP_GUARD, useClass: JwtAuthGuard }];\n');
    const result = await analyzeNestjsApi(dir, contextFor(dir));
    expect(result.issues.map((i) => i.rule)).not.toContain("missing-guard");
    expect(result.summary).toMatch(/global guard/);
  });

  it("honours ignore entries and reports a project without controllers", async () => {
    const result = await analyzeNestjsApi(NEST_FIXTURE, contextFor(NEST_FIXTURE, ["src/posts", "src/users", "src/auth"]));
    expect(result).toMatchObject({ score: 0, issues: [expect.objectContaining({ rule: "no-controllers" })] });
  });
});

describe("analyzeExpressApi", () => {
  it("discovers mounted routes and reports the unprotected POST /users", async () => {
    const result = await analyzeExpressApi(EXPRESS_FIXTURE, contextFor(EXPRESS_FIXTURE));
    expect(issueList(result)).toEqual([
      "missing-validation POST /login reads the request body without validation @src/app.js:17",
      "missing-auth POST /users has no auth middleware @src/routes/users.js:13",
      "missing-validation POST /users reads the request body without validation @src/routes/users.js:13",
      "unhandled-async POST /users has an async handler without error handling @src/routes/users.js:13",
    ]);
    expect(result?.summary).toBe("7 routes across 3 files");
    // auth 3/4 (POST /users missing; /login is public by design), validation 1/3 (only PUT validates), async 6/7
    expect(result?.score).toBe(Math.round((3 / 4) * 45 + (1 / 3) * 35 + (6 / 7) * 20));
  });

  it("does not flag async handlers on Express 5", async () => {
    const dir = copyFixture(EXPRESS_FIXTURE);
    writeProjectFile(dir, "package.json", JSON.stringify({ dependencies: { express: "^5.1.0" } }));
    const result = await analyzeExpressApi(dir, contextFor(dir));
    expect(result?.issues.map((i) => i.rule)).not.toContain("unhandled-async");
  });

  it("returns null (not applicable) when no routes are found", async () => {
    const dir = tempProject({ "package.json": JSON.stringify({ dependencies: { express: "^4" } }), "src/util.js": "module.exports = 1;" });
    expect(await analyzeExpressApi(dir, contextFor(dir))).toBeNull();
  });

  it("honours ignore entries", async () => {
    expect(await analyzeExpressApi(EXPRESS_FIXTURE, contextFor(EXPRESS_FIXTURE, ["src"]))).toBeNull();
  });
});

describe("analyzeNextjsApi", () => {
  it("reports App Router and pages/api handlers without auth or validation", async () => {
    const result = await analyzeNextjsApi(NEXT_FIXTURE, contextFor(NEXT_FIXTURE));
    expect(issueList(result)).toEqual([
      "missing-auth POST /api/users has no auth check @app/api/users/route.ts:9",
      "missing-validation POST /api/users reads the request body without validation @app/api/users/route.ts:9",
      "missing-auth POST /api/legacy/feedback has no auth check @pages/api/legacy/feedback.ts:4",
      "missing-validation POST /api/legacy/feedback reads the request body without validation @pages/api/legacy/feedback.ts:4",
    ]);
    expect(result?.summary).toBe("7 route handlers across 4 files");
    // auth 2/4 (PATCH + DELETE protected), validation 1/3 (PATCH)
    expect(result?.score).toBe(Math.round(0.5 * 55 + (1 / 3) * 45));
  });

  it("returns null for a Next.js app without API routes", async () => {
    const dir = tempProject({ "package.json": JSON.stringify({ dependencies: { next: "^15" } }), "app/page.tsx": "export default function P() { return null; }" });
    expect(await analyzeNextjsApi(dir, contextFor(dir))).toBeNull();
  });
});

describe("api-common", () => {
  it.each([
    ["/auth/login", true],
    ["/api/auth/[...nextauth]", true],
    ["/webhooks/stripe", true],
    ["/users/:id/password", false],
    ["/authors", false],
  ])("isPublicByDesign(%s) = %s", (path, expected) => {
    expect(isPublicByDesign(path)).toBe(expected);
  });

  it("joins route paths", () => {
    expect(joinRoutePath("", "")).toBe("/");
    expect(joinRoutePath("/api/", "/users/")).toBe("/api/users");
    expect(joinRoutePath("api", ":id")).toBe("/api/:id");
  });
});

