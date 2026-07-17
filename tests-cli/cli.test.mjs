import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const cli = resolve("dist/index.js");
const scanResultSchema = JSON.parse(
  readFileSync(
    new URL("../schema/scan-result.schema.json", import.meta.url),
    "utf-8",
  ),
);
const validateScanResult = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(scanResultSchema);

function runCli(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

test("built CLI reports the package version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  );
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("threshold applies outside CI mode and config controls analyzers", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "fixture", devDependencies: {} }),
    );
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 1",
        "analyzers:",
        "  api: false",
        "  security: false",
        "  dependencies: false",
        "  testing: false",
        "  structure: false",
      ].join("\n"),
    );

    assert.equal(runCli(["scan", ".", "--quiet"], directory).status, 1);
    assert.equal(
      runCli(["scan", ".", "--quiet", "--threshold", "0"], directory).status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plain scans without config are informational", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "fixture", devDependencies: {} }),
    );

    assert.equal(runCli(["scan", ".", "--quiet"], directory).status, 0);
    assert.equal(
      runCli(["scan", ".", "--quiet", "--threshold", "100"], directory).status,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SVG output is valid badge markup on stdout", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "badge-fixture", devDependencies: {} }),
    );

    const result = runCli(["scan", ".", "--format", "svg"], directory);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
    );
    assert.match(result.stdout, /aria-label="codediag:/);
    assert.match(result.stdout, /<\/svg>\s*$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown output formats fail explicitly", () => {
  const result = runCli(["scan", ".", "--format", "xml"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown output format "xml"/);
});

test("built CLI JSON output conforms to the published schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "schema-fixture", devDependencies: {} }),
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
        "  structure: false",
      ].join("\n"),
    );

    const result = runCli(["scan", ".", "--format", "json"], directory);
    assert.equal(result.status, 0);
    assert.equal(
      validateScanResult(JSON.parse(result.stdout)),
      true,
      JSON.stringify(validateScanResult.errors),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
