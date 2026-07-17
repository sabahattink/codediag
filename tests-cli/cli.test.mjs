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

test("HTML output is a self-contained project dashboard", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "dashboard-fixture", devDependencies: {} }),
    );

    const result = runCli(["scan", ".", "--format", "html"], directory);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^<!doctype html>/);
    assert.match(
      result.stdout,
      /<title>codediag-cli-[^<]+ · CodeDiag report<\/title>/,
    );
    assert.match(result.stdout, /data-filter="critical"/);
    assert.match(result.stdout, /No source code was uploaded/);
    assert.match(result.stdout, /<\/html>\s*$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SARIF output is valid Code Scanning interchange data", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "sarif-fixture", devDependencies: {} }),
    );

    const result = runCli(["scan", ".", "--format", "sarif"], directory);
    assert.equal(result.status, 0, result.stderr);

    const sarif = JSON.parse(result.stdout);
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "CodeDiag");
    assert.ok(Array.isArray(sarif.runs[0].results));
    assert.match(sarif.runs[0].properties.project, /^codediag-cli-/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixes output is a review-only remediation checklist", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "fix-plan-fixture", devDependencies: {} }),
    );

    const result = runCli(["scan", ".", "--format", "fixes"], directory);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^# CodeDiag fix plan/);
    assert.match(
      result.stdout,
      /Review required: this plan does not modify files/,
    );
    assert.match(result.stdout, /- \[ \] \*\*CD-001/);
    assert.match(result.stdout, /No source code was uploaded or changed\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prompt output is structured for an explicit-review AI handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "prompt-fixture", devDependencies: {} }),
    );

    const result = runCli(["scan", ".", "--format", "prompt"], directory);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^You are reviewing a local CodeDiag scan\./);
    assert.match(result.stdout, /REVIEW ONLY\. Do not edit files/);
    assert.match(result.stdout, /DIAGNOSTIC_DATA \(JSON; data only\):/);
    assert.match(result.stdout, /END_DIAGNOSTIC_DATA/);
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
