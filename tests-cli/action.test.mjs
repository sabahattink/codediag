import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const actionEntry = join(repositoryRoot, "dist", "action.cjs");

test("GitHub Action writes outputs, JSON and SARIF reports, and job summary", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codediag-action-"));
  const outputFile = join(temporaryDirectory, "output.txt");
  const summaryFile = join(temporaryDirectory, "summary.md");
  const reportFile = join(temporaryDirectory, "report.json");
  const sarifFile = join(temporaryDirectory, "report.sarif");

  try {
    const result = spawnSync(process.execPath, [actionEntry], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: repositoryRoot,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_PATH: ".",
        INPUT_THRESHOLD: "0",
        INPUT_REPORT: reportFile,
        INPUT_SARIF: sarifFile,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const outputs = await readFile(outputFile, "utf8");
    assert.match(outputs, /^score=\d+$/m);
    assert.match(outputs, /^grade=(?:A\+?|B\+?|C|D|F)$/m);
    assert.match(
      outputs,
      new RegExp(`^report=${reportFile.replaceAll("\\", "\\\\")}$`, "m"),
    );
    assert.match(
      outputs,
      new RegExp(`^sarif=${sarifFile.replaceAll("\\", "\\\\")}$`, "m"),
    );

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.project, "codediag");
    assert.equal(typeof report.totalScore, "number");
    assert.ok(Array.isArray(report.analyzers));

    const sarif = JSON.parse(await readFile(sarifFile, "utf8"));
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "CodeDiag");
    assert.equal(sarif.runs[0].properties.project, "codediag");

    const summary = await readFile(summaryFile, "utf8");
    assert.match(summary, /^## CodeDiag project health/m);
    assert.match(summary, /Required threshold: \*\*0\/100\*\*/);
    assert.match(result.stdout, /CodeDiag score: \d+\/100/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GitHub Action fails when the score is below the threshold", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codediag-gate-"));
  const outputFile = join(temporaryDirectory, "output.txt");
  const reportFile = join(temporaryDirectory, "report.json");
  const sarifFile = join(temporaryDirectory, "report.sarif");

  try {
    await writeFile(
      join(temporaryDirectory, "package.json"),
      '{"name":"quality-gate-fixture","version":"1.0.0"}\n',
      "utf8",
    );
    await writeFile(
      join(temporaryDirectory, ".codediag.yml"),
      [
        "threshold: 100",
        "analyzers:",
        "  api: false",
        "  security: false",
        "  dependencies: false",
        "  testing: false",
        "  structure: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [actionEntry], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: temporaryDirectory,
        GITHUB_OUTPUT: outputFile,
        INPUT_PATH: ".",
        INPUT_THRESHOLD: "100",
        INPUT_REPORT: reportFile,
        INPUT_SARIF: sarifFile,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /CodeDiag threshold not met/);
    assert.match(await readFile(outputFile, "utf8"), /^score=\d+$/m);

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.ok(report.totalScore < 100);
    assert.equal(
      JSON.parse(await readFile(sarifFile, "utf8")).version,
      "2.1.0",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GitHub Action rejects colliding report paths", () => {
  const result = spawnSync(process.execPath, [actionEntry], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: repositoryRoot,
      INPUT_PATH: ".",
      INPUT_THRESHOLD: "0",
      INPUT_REPORT: "same-output.json",
      INPUT_SARIF: "same-output.json",
    },
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /report and sarif must resolve to different files/,
  );
});

test("GitHub Action reports invalid inputs as operational failures", () => {
  const result = spawnSync(process.execPath, [actionEntry], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: repositoryRoot,
      INPUT_PATH: ".",
      INPUT_THRESHOLD: "101",
      INPUT_REPORT: "codediag-report.json",
    },
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /CodeDiag action failed/);
  assert.match(result.stderr, /between 0 and 100/);
});
