import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scanner.js";

test("scan honors analyzer selection from .codediag.yml", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-scan-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "fixture", devDependencies: {} }),
    );
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 0",
        "analyzers:",
        "  api: false",
        "  security: false",
        "  dependencies: false",
        "  testing: false",
        "  structure: true",
      ].join("\n"),
    );

    const result = await scan(directory, loadConfig(directory));
    assert.deepEqual(
      result.analyzers.map((analyzer) => analyzer.name),
      ["Structure"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
