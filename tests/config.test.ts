import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isBelowThreshold,
  loadConfig,
  normalizeIgnorePatterns,
  parseThreshold,
} from "../src/config.js";

function withProject(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-config-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("loads validated analyzer settings and ignore patterns", () => {
  withProject((directory) => {
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 82",
        "ignore:",
        "  - generated",
        "analyzers:",
        "  api: false",
        "  security: true",
      ].join("\n"),
    );

    const config = loadConfig(directory);
    assert.equal(config.threshold, 82);
    assert.deepEqual(config.ignore, ["generated"]);
    assert.equal(config.analyzers.api, false);
    assert.equal(config.analyzers.security, true);
    assert.equal(config.analyzers.dependencies, true);
  });
});

test("rejects invalid and unknown configuration", () => {
  withProject((directory) => {
    writeFileSync(join(directory, ".codediag.yml"), "threshold: 101\n");
    assert.throws(() => loadConfig(directory), /threshold must be an integer/);

    writeFileSync(join(directory, ".codediag.yml"), "futureOption: true\n");
    assert.throws(() => loadConfig(directory), /unknown option/);
  });
});

test("normalizes directories without corrupting glob patterns", () => {
  assert.deepEqual(normalizeIgnorePatterns(["dist", "generated/**"]), [
    "dist",
    "dist/**",
    "generated/**",
  ]);
});

test("threshold parsing and comparison are deterministic", () => {
  assert.equal(parseThreshold("80"), 80);
  assert.equal(isBelowThreshold(79, 80), true);
  assert.equal(isBelowThreshold(80, 80), false);
  assert.throws(() => parseThreshold("80x"), /threshold must be an integer/);
});
