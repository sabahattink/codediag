import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

test("Markdown output explains lost points with scoring version 2", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, "index.ts"), "export const a = 1;\n");
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 0",
        "analyzers:",
        "  api: false",
        "  security: false",
        "  dependencies: false",
        "  testing: true",
        "  structure: false",
      ].join("\n"),
    );

    const result = runCli(["scan", ".", "--format", "md"], directory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Testing \| 0\/100 \|/);
    assert.match(result.stdout, /### Score breakdown/);
    assert.match(
      result.stdout,
      /\| Testing \| `no-test-files` \| 1 \| -100 \|/,
    );
    assert.match(
      result.stdout,
      /\| Testing \| `no-test-framework` \| 1 \| -8 \|/,
    );
    assert.doesNotMatch(result.stdout, /zero-test-ratio/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("baselines accept existing findings and fail only on new ones", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, "run.js"), "eval(a);\n");
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 100",
        "analyzers:",
        "  api: false",
        "  security: true",
        "  dependencies: false",
        "  testing: false",
        "  structure: false",
      ].join("\n"),
    );

    const update = runCli(
      ["scan", ".", "--quiet", "--update-baseline", "reports/baseline.json"],
      directory,
    );
    assert.equal(update.status, 1, "the unbaselined scan misses 100");
    const baseline = JSON.parse(
      readFileSync(join(directory, "reports", "baseline.json"), "utf-8"),
    );
    assert.equal(validateScanResult(baseline), true);

    const accepted = runCli(
      ["scan", ".", "--ci", "--baseline", "reports/baseline.json"],
      directory,
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    const report = JSON.parse(accepted.stdout);
    assert.equal(report.totalScore, 100);
    assert.deepEqual(report.baseline, { matched: 1, fixed: 0 });

    writeFileSync(join(directory, "run.js"), "eval(a);\neval(b);\n");
    const regressed = runCli(
      ["scan", ".", "--quiet", "--baseline", "reports/baseline.json"],
      directory,
    );
    assert.equal(regressed.status, 1);

    const missing = runCli(
      ["scan", ".", "--baseline", "missing.json"],
      directory,
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cannot read baseline/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--ci keeps an explicitly chosen output format", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(
      join(directory, ".codediag.yml"),
      "threshold: 0\nanalyzers:\n  dependencies: false\n",
    );

    const sarif = runCli(["scan", ".", "--ci", "--format", "sarif"], directory);
    assert.equal(sarif.status, 0, sarif.stderr);
    assert.equal(JSON.parse(sarif.stdout).version, "2.1.0");

    const json = runCli(["scan", ".", "--ci"], directory);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(validateScanResult(JSON.parse(json.stdout)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init writes the config into the given project directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    const project = join(directory, "service");
    mkdirSync(project);

    const result = runCli(["init", "service"], directory);

    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(join(project, ".codediag.yml"), "utf-8");
    assert.match(config, /^threshold: 70$/m);
    assert.equal(
      runCli(["scan", "service", "--quiet", "--threshold", "0"], directory)
        .status,
      0,
      "the generated config must load",
    );
    assert.equal(runCli(["init", "missing"], directory).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown output dates the report from the scan timestamp", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(
      join(directory, ".codediag.yml"),
      "threshold: 0\nanalyzers:\n  dependencies: false\n",
    );

    const result = runCli(["scan", ".", "--format", "md"], directory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, / on \d{4}-\d{2}-\d{2}$/m);
    assert.match(result.stdout, /^\*\*Findings:\*\* \d+ critical/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--no-audit scans offline and reports the skipped audit", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, "package-lock.json"), "{}");

    const result = runCli(["scan", ".", "--ci", "--no-audit"], directory);
    const report = JSON.parse(result.stdout);
    const dependencies = report.analyzers.find(
      (analyzer) => analyzer.name === "Dependencies",
    );

    assert.deepEqual(
      dependencies.issues
        .filter((issue) => issue.rule.startsWith("audit"))
        .map((issue) => issue.rule),
      ["audit-skipped"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rules lists the registry and explain describes or suggests rules", () => {
  const list = runCli(["rules", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  const rules = JSON.parse(list.stdout);
  assert.ok(rules.length > 60);
  assert.ok(
    rules.some(
      (rule) =>
        rule.id === "dynamic-sql-query" &&
        rule.docsUrl.endsWith("docs/rules.md#dynamic-sql-query"),
    ),
  );

  const explained = runCli(["explain", "open-cors"]);
  assert.equal(explained.status, 0, explained.stderr);
  assert.match(explained.stdout, /CWE-942/);
  assert.match(explained.stdout, /codediag-ignore-next-line open-cors --/);

  const unknown = runCli(["explain", "open-cor"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Did you mean open-cors\?/);
});
