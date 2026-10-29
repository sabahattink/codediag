import { describe, it, expect, afterEach } from "vitest";
import { analyzeTesting } from "../src/analyzers/testing.js";
import { analyzeStructure } from "../src/analyzers/structure.js";
import {
  EXPRESS_FIXTURE,
  NEST_FIXTURE,
  NEXT_FIXTURE,
  NODE_FIXTURE,
  cleanupTempProjects,
  contextFor,
  tempProject,
} from "./helpers.js";

afterEach(cleanupTempProjects);

describe("analyzeTesting", () => {
  it("finds .spec.ts and Nest .e2e-spec.ts files and jest config in package.json", async () => {
    const result = await analyzeTesting(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    expect(result.summary).toBe("2 test files, framework: jest");
    expect(result.issues.map((i) => i.rule)).toEqual(["low-test-ratio"]);
    expect(result.score).toBe(92);
  });

  it("reports a project without tests", async () => {
    const result = await analyzeTesting(NEXT_FIXTURE, contextFor(NEXT_FIXTURE));
    expect(result.issues.map((i) => i.rule)).toEqual(
      expect.arrayContaining(["no-test-files", "no-test-framework", "zero-test-ratio", "no-e2e-dir", "no-coverage-config"])
    );
    expect(result.score).toBe(0);
  });

  it("honours ignore entries when counting tests", async () => {
    const all = await analyzeTesting(EXPRESS_FIXTURE, contextFor(EXPRESS_FIXTURE));
    const ignored = await analyzeTesting(EXPRESS_FIXTURE, contextFor(EXPRESS_FIXTURE, ["test"]));
    expect(all.summary).toMatch(/^1 test files/);
    expect(ignored.summary).toMatch(/^0 test files/);
  });

  it("detects a coverage threshold in vitest.config", async () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }),
      "vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 80 } } } };",
      "src/a.ts": "",
      "src/a.test.ts": "",
      "test/b.test.ts": "",
    });
    const result = await analyzeTesting(dir, contextFor(dir));
    expect(result).toMatchObject({ score: 100, issues: [] });
  });
});

describe("analyzeStructure", () => {
  it("parses a tsconfig with comments and trailing commas (strict: true)", async () => {
    const result = await analyzeStructure(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    const rules = result.issues.map((i) => i.rule);
    expect(rules).not.toContain("invalid-tsconfig");
    expect(rules).not.toContain("no-strict-mode");
    expect(rules).not.toContain("poor-module-org");
  });

  it("follows tsconfig extends to find strict mode", async () => {
    const dir = tempProject({
      "package.json": "{}",
      "tsconfig.base.json": '{ "compilerOptions": { "strict": true } }',
      "tsconfig.json": '{ "extends": "./tsconfig.base.json", "compilerOptions": { "outDir": "dist" } }',
      "src/index.ts": "",
    });
    expect((await analyzeStructure(dir, contextFor(dir))).issues.map((i) => i.rule)).not.toContain("no-strict-mode");
  });

  it("lets a child tsconfig turn strict off", async () => {
    const dir = tempProject({
      "package.json": "{}",
      "tsconfig.base.json": '{ "compilerOptions": { "strict": true } }',
      "tsconfig.json": '{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": false } }',
    });
    expect((await analyzeStructure(dir, contextFor(dir))).issues.map((i) => i.rule)).toContain("no-strict-mode");
  });

  it("only checks NestJS module organization for NestJS projects", async () => {
    const files = {
      "src/alpha/helper.ts": "",
      "src/beta/helper.ts": "",
      "src/gamma/helper.ts": "",
    };
    const generic = tempProject({ ...files, "package.json": JSON.stringify({ dependencies: {} }) });
    const nest = tempProject({ ...files, "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^11" } }) });
    expect((await analyzeStructure(generic, contextFor(generic))).issues.map((i) => i.rule)).not.toContain("poor-module-org");
    expect((await analyzeStructure(nest, contextFor(nest))).issues.map((i) => i.rule)).toContain("poor-module-org");
    expect((await analyzeStructure(nest, contextFor(nest, ["src/alpha", "src/beta", "src/gamma"]))).issues.map((i) => i.rule)).not.toContain("poor-module-org");
  });

  it("accepts app/ or pages/ as the source directory for Next.js", async () => {
    const result = await analyzeStructure(NEXT_FIXTURE, contextFor(NEXT_FIXTURE));
    expect(result.issues.map((i) => i.rule)).not.toContain("no-src-dir");
  });

  it("does not penalize JavaScript projects for having no tsconfig", async () => {
    const result = await analyzeStructure(NODE_FIXTURE, contextFor(NODE_FIXTURE));
    expect(result.summary).toBe("3/6 checks passed");
  });

  it("detects linter/formatter config in package.json and newer file names", async () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ prettier: {} }),
      "eslint.config.ts": "export default [];",
      ".editorconfig": "root = true",
      "README.md": "x".repeat(200),
      "src/index.ts": "",
    });
    expect(await analyzeStructure(dir, contextFor(dir))).toMatchObject({ score: 100, issues: [] });
  });
});
