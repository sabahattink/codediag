import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

test("--compare reports the score change and new or fixed findings", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, "run.js"), "eval(a);\n");
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "analyzers:",
        "  api: false",
        "  dependencies: false",
        "  testing: false",
        "  structure: false",
      ].join("\n"),
    );
    const before = runCli(["scan", ".", "--format", "json"], directory);
    writeFileSync(join(directory, "previous.json"), before.stdout);

    writeFileSync(join(directory, "run.js"), "new Function(a);\n");
    const compared = runCli(
      ["scan", ".", "--format", "json", "--compare", "previous.json"],
      directory,
    );
    assert.equal(compared.status, 0, compared.stderr);
    const report = JSON.parse(compared.stdout);
    assert.equal(validateScanResult(report), true);
    assert.equal(report.comparison.newFindings, 1);
    assert.equal(report.comparison.fixedFindings, 1);
    assert.equal(
      report.comparison.fixed[0].message,
      "Runtime code execution uses eval()",
    );
    assert.equal(report.analyzers[0].issues[0].isNew, true);

    const terminal = runCli(
      ["scan", ".", "--compare", "previous.json"],
      directory,
    );
    assert.match(terminal.stdout, /Change: .* 1 new .* 1 fixed/);

    const invalid = runCli(
      ["scan", ".", "--compare", "package.json"],
      directory,
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not a CodeDiag JSON report/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--changed-since cannot rewrite a whole-project baseline", () => {
  const result = runCli([
    "scan",
    ".",
    "--changed-since",
    "HEAD",
    "--update-baseline",
    "baseline.json",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined with --changed-since/);
});

test("--workspaces scans each package and combines the reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    for (const name of ["api", "web"]) {
      mkdirSync(join(directory, "packages", name, "src"), { recursive: true });
      writeFileSync(
        join(directory, "packages", name, "package.json"),
        JSON.stringify({ name: `@acme/${name}` }),
      );
      writeFileSync(
        join(directory, "packages", name, "src", "index.js"),
        name === "api" ? "eval(input);\n" : "export const ok = 1;\n",
      );
    }

    const combined = runCli(
      ["scan", ".", "--workspaces", "--format", "json", "--no-audit"],
      directory,
    );
    assert.equal(combined.status, 0, combined.stderr);
    const report = JSON.parse(combined.stdout);
    assert.equal(validateScanResult(report), true);
    assert.deepEqual(
      report.workspace.packages.map((entry) => entry.path),
      ["packages/api", "packages/web"],
    );
    const security = report.analyzers.find((a) => a.name === "Security");
    assert.ok(
      security.issues.some(
        (issue) =>
          issue.rule === "unsafe-dynamic-code" &&
          issue.file === "packages/api/src/index.js",
      ),
    );

    const hint = runCli(["scan", ".", "--no-audit"], directory);
    assert.match(
      hint.stdout,
      /npm workspace with 2 packages; add --workspaces to scan each one/,
    );

    const terminal = runCli(
      ["scan", ".", "--workspaces", "--no-audit"],
      directory,
    );
    assert.match(terminal.stdout, /Packages \(npm workspace, 2\)/);
    assert.match(terminal.stdout, /packages\/api .* \d+ /);

    const single = runCli(["scan", "packages/web", "--workspaces"], directory);
    assert.equal(single.status, 1);
    assert.match(single.stderr, /No workspace packages found/);

    // The api package's eval() puts it below the web package; gate between.
    const [api, web] = report.workspace.packages.map(
      (entry) => entry.totalScore,
    );
    assert.ok(api < web);
    const gated = runCli(
      [
        "scan",
        ".",
        "--workspaces",
        "--package-threshold",
        String(web),
        "--threshold",
        "0",
        "--no-audit",
      ],
      directory,
    );
    assert.equal(gated.status, 1);
    assert.equal(
      gated.stderr.match(/below its package threshold/g)?.length,
      1,
      gated.stderr,
    );
    assert.match(
      gated.stderr,
      new RegExp(
        `packages/api scored ${api}, below its package threshold ${web}`,
      ),
    );
    assert.match(gated.stdout, new RegExp(`packages/api .* below ${web}`));

    const notWorkspace = runCli(
      ["scan", ".", "--package-threshold", "50", "--no-audit"],
      directory,
    );
    assert.equal(notWorkspace.status, 1);
    assert.match(notWorkspace.stderr, /--package-threshold needs --workspaces/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--history records each scan and reports the trend", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, "run.js"), "eval(a);\n");

    const first = runCli(
      ["scan", ".", "--no-audit", "--history", "history"],
      directory,
    );
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Trend: +first recorded scan/);

    writeFileSync(join(directory, "run.js"), "export const ok = 1;\n");
    const second = runCli(
      ["scan", ".", "--no-audit", "--history", "history", "--format", "json"],
      directory,
    );
    const report = JSON.parse(second.stdout);
    assert.equal(validateScanResult(report), true);
    assert.equal(report.history.length, 2);
    assert.ok(report.history[1].totalScore > report.history[0].totalScore);
    assert.equal(readdirSync(join(directory, "history")).length, 2);

    const scoped = runCli(
      ["scan", ".", "--history", "history", "--changed-since", "HEAD"],
      directory,
    );
    assert.equal(scoped.status, 1);
    assert.match(scoped.stderr, /cannot be combined with --changed-since/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--fail-on fails on active findings at or above a severity", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-cli-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, "run.js"), "eval(a);\n");
    const securityOnly = [
      "analyzers:",
      "  api: false",
      "  dependencies: false",
      "  testing: false",
      "  structure: false",
    ];
    writeFileSync(join(directory, ".codediag.yml"), securityOnly.join("\n"));
    const scan = (...args) =>
      runCli(
        ["scan", ".", "--threshold", "0", "--no-audit", ...args],
        directory,
      );

    const passing = scan("--quiet");
    assert.equal(passing.status, 0, "the threshold alone passes");

    const failing = scan("--fail-on", "critical", "--format", "json");
    assert.equal(failing.status, 1);
    assert.match(
      failing.stderr,
      /1 active finding at or above critical severity \(fail-on: critical\)/,
    );
    assert.equal(JSON.parse(failing.stdout).totalScore > 0, true);

    // A justified suppression removes the finding from the gate.
    writeFileSync(
      join(directory, "run.js"),
      "// codediag-ignore-next-line unsafe-dynamic-code -- input is a constant\neval(a);\n",
    );
    assert.equal(scan("--fail-on", "critical", "--quiet").status, 0);

    writeFileSync(join(directory, "run.js"), "eval(a);\n");
    writeFileSync(
      join(directory, ".codediag.yml"),
      ["failOn: warning", ...securityOnly].join("\n"),
    );
    const configured = scan("--quiet");
    assert.equal(configured.status, 1);
    assert.match(
      configured.stderr,
      /1 active finding at or above warning severity \(fail-on: warning\)/,
    );

    const invalid = scan("--fail-on", "high");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /fail-on must be critical, warning, or info/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
