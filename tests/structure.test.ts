import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeStructure } from "../src/analyzers/structure.js";

function createProject(): string {
  return mkdtempSync(join(tmpdir(), "codediag-structure-"));
}

function writeMeaningfulReadme(directory: string): void {
  writeFileSync(
    join(directory, "README.md"),
    "# Example\n\n" +
      "A documented JavaScript project with installation, usage, and maintenance guidance. ".repeat(
        2,
      ),
  );
}

test("structure analyzer does not penalize JavaScript for missing tsconfig", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({}));
    writeFileSync(join(directory, ".editorconfig"), "root = true\n");
    writeFileSync(join(directory, "biome.jsonc"), "{ /* config */ }\n");

    const result = await analyzeStructure(directory);

    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
    assert.equal(result.summary, "5/5 checks passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer requires strict mode for TypeScript", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "5.0.0" } }),
    );
    writeFileSync(join(directory, ".editorconfig"), "root = true\n");
    writeFileSync(join(directory, "eslint.config.mjs"), "export default [];\n");
    writeFileSync(
      join(directory, "prettier.config.mjs"),
      "export default {};\n",
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );

    const result = await analyzeStructure(directory);

    assert.equal(
      result.issues.some((issue) => issue.rule === "no-strict-mode"),
      true,
    );
    assert.equal(result.score, 83);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer reports a missing tsconfig for TypeScript", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "5.0.0" } }),
    );

    const result = await analyzeStructure(directory);

    assert.equal(
      result.issues.some((issue) => issue.rule === "no-tsconfig"),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer resolves JSONC and inherited strict mode", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        devDependencies: { typescript: "5.0.0" },
        eslintConfig: { extends: [] },
        prettier: {},
      }),
    );
    writeFileSync(join(directory, ".editorconfig"), "root = true\n");
    writeFileSync(
      join(directory, "tsconfig.base.json"),
      '{\n  // inherited compiler policy\n  "compilerOptions": { "strict": true, },\n}\n',
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      '{\n  "extends": "./tsconfig.base.json",\n}\n',
    );

    const result = await analyzeStructure(directory);

    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
    assert.equal(result.summary, "6/6 checks passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer finds workspace-level editor and lint configs", async () => {
  const workspace = createProject();
  const directory = join(workspace, "packages", "service");
  try {
    mkdirSync(directory, { recursive: true });
    writeMeaningfulReadme(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({}));
    writeFileSync(join(workspace, ".editorconfig"), "root = true\n");
    writeFileSync(join(workspace, "eslint.config.mjs"), "export default [];\n");
    writeFileSync(
      join(workspace, "prettier.config.cjs"),
      "module.exports = {};\n",
    );

    const result = await analyzeStructure(directory);

    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("structure analyzer rejects a badge-only README", async () => {
  const directory = createProject();
  try {
    writeFileSync(
      join(directory, "README.md"),
      '<p align="center">\n' +
        '<img src="logo.svg" alt="logo" />\n'.repeat(10) +
        "</p>\n",
    );
    writeFileSync(join(directory, "package.json"), JSON.stringify({}));

    const result = await analyzeStructure(directory);

    assert.equal(
      result.issues.some((issue) => issue.rule === "short-readme"),
      true,
    );
    assert.equal(result.summary, "1/5 checks passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer requires a template for environment variants", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({}));
    writeFileSync(join(directory, ".env.production"), "TOKEN=secret\n");

    const missingTemplate = await analyzeStructure(directory);
    assert.equal(
      missingTemplate.issues.some((issue) => issue.rule === "no-env-example"),
      true,
    );

    writeFileSync(join(directory, ".env.sample"), "TOKEN=\n");
    const withTemplate = await analyzeStructure(directory);
    assert.equal(
      withTemplate.issues.some((issue) => issue.rule === "no-env-example"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer ignores NestJS utility directories without handlers", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    mkdirSync(join(directory, "src", "common", "decorators"), {
      recursive: true,
    });
    writeFileSync(
      join(directory, "src", "app.module.ts"),
      "export class AppModule {}\n",
    );
    writeFileSync(
      join(directory, "src", "common", "decorators", "public.ts"),
      "export const Public = true;\n",
    );

    const result = await analyzeStructure(directory);

    assert.equal(
      result.issues.some((issue) => issue.rule === "poor-module-org"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer reports NestJS handler directories without a module", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    mkdirSync(join(directory, "src", "auth"), { recursive: true });
    writeFileSync(
      join(directory, "src", "app.module.ts"),
      "export class AppModule {}\n",
    );
    writeFileSync(
      join(directory, "src", "auth", "auth.controller.ts"),
      "export class AuthController {}\n",
    );
    writeFileSync(
      join(directory, "src", "auth", "auth.service.ts"),
      "export class AuthService {}\n",
    );

    const withoutModule = await analyzeStructure(directory);
    const issue = withoutModule.issues.find(
      (candidate) => candidate.rule === "poor-module-org",
    );
    assert.equal(issue?.file, "src/auth");

    writeFileSync(
      join(directory, "src", "auth", "auth.module.ts"),
      "export class AuthModule {}\n",
    );
    const withModule = await analyzeStructure(directory);
    assert.equal(
      withModule.issues.some(
        (candidate) => candidate.rule === "poor-module-org",
      ),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer accepts a feature module above nested handlers", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    mkdirSync(join(directory, "src", "users", "controllers"), {
      recursive: true,
    });
    writeFileSync(
      join(directory, "src", "app.module.ts"),
      "export class AppModule {}\n",
    );
    writeFileSync(
      join(directory, "src", "users", "users.module.ts"),
      "export class UsersModule {}\n",
    );
    writeFileSync(
      join(directory, "src", "users", "controllers", "users.controller.ts"),
      "export class UsersController {}\n",
    );

    const result = await analyzeStructure(directory);

    assert.equal(
      result.issues.some((issue) => issue.rule === "poor-module-org"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structure analyzer honors ignore patterns for NestJS feature checks", async () => {
  const directory = createProject();
  try {
    writeMeaningfulReadme(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    mkdirSync(join(directory, "src", "generated"), { recursive: true });
    writeFileSync(
      join(directory, "src", "app.module.ts"),
      "export class AppModule {}\n",
    );
    writeFileSync(
      join(directory, "src", "generated", "client.service.ts"),
      "export class ClientService {}\n",
    );

    const result = await analyzeStructure(directory, ["src/generated/**"]);

    assert.equal(
      result.issues.some((issue) => issue.rule === "poor-module-org"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
