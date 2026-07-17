import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
