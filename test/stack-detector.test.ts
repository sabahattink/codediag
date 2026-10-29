import { describe, it, expect, afterEach } from "vitest";
import { detectStack } from "../src/detectors/stack-detector.js";
import { EXPRESS_FIXTURE, NEST_FIXTURE, NEXT_FIXTURE, NODE_FIXTURE, cleanupTempProjects, tempProject } from "./helpers.js";

afterEach(cleanupTempProjects);

describe("detectStack", () => {
  it("detects NestJS + TypeScript + Prisma", () => {
    expect(detectStack(NEST_FIXTURE)).toMatchObject({ framework: "nestjs", language: "typescript", orm: "prisma", hasPrisma: true, hasTests: true });
  });

  it("detects Express + JavaScript", () => {
    expect(detectStack(EXPRESS_FIXTURE)).toMatchObject({ framework: "express", language: "javascript", orm: null });
  });

  it("detects Next.js", () => {
    expect(detectStack(NEXT_FIXTURE)).toMatchObject({ framework: "nextjs", language: "typescript" });
  });

  it("detects a plain Node project as generic", () => {
    expect(detectStack(NODE_FIXTURE)).toMatchObject({ framework: "generic", language: "javascript", hasTests: false });
  });

  it("prefers NestJS over Express when both are installed", () => {
    const dir = tempProject({ "package.json": JSON.stringify({ dependencies: { express: "^4", "@nestjs/core": "^11" } }) });
    expect(detectStack(dir).framework).toBe("nestjs");
  });

  it("detects Next.js from next.config.* without the dependency", () => {
    const dir = tempProject({ "package.json": "{}", "next.config.mjs": "export default {};" });
    expect(detectStack(dir).framework).toBe("nextjs");
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("detects the package manager from %s", (lockFile, manager) => {
    const dir = tempProject({ "package.json": "{}", [lockFile]: "" });
    expect(detectStack(dir).packageManager).toBe(manager);
  });

  it("detects ORMs, Docker and env files", () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ dependencies: { "drizzle-orm": "^0.36" } }),
      "Dockerfile": "FROM node:22",
      ".env.example": "PORT=3000",
    });
    expect(detectStack(dir)).toMatchObject({ orm: "drizzle", hasDocker: true, hasEnvFile: true });
  });

  it("returns unknown without package.json or with invalid JSON", () => {
    expect(detectStack(tempProject({ "index.js": "" })).framework).toBe("unknown");
    expect(detectStack(tempProject({ "package.json": "{ not json" })).framework).toBe("unknown");
  });

  it("returns unknown for a package.json without dependencies", () => {
    expect(detectStack(tempProject({ "package.json": '{ "name": "x" }' })).framework).toBe("unknown");
  });
});
