import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("GitHub Action excludes baseline findings from annotations and the gate", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "codediag-baseline-"),
  );
  const reportFile = join(temporaryDirectory, "report.json");
  const run = (inputs) =>
    spawnSync(process.execPath, [actionEntry], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: temporaryDirectory,
        INPUT_PATH: ".",
        INPUT_THRESHOLD: "100",
        INPUT_REPORT: reportFile,
        INPUT_SARIF: join(temporaryDirectory, "report.sarif"),
        ...inputs,
      },
    });

  try {
    await writeFile(join(temporaryDirectory, "package.json"), "{}\n", "utf8");
    await writeFile(join(temporaryDirectory, ".gitignore"), ".env\n", "utf8");
    await writeFile(join(temporaryDirectory, "run.js"), "eval(a);\n", "utf8");
    await writeFile(
      join(temporaryDirectory, ".codediag.yml"),
      [
        "analyzers:",
        "  api: false",
        "  security: true",
        "  dependencies: false",
        "  testing: false",
        "  structure: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const first = run({});
    assert.equal(first.status, 1, first.stdout);
    assert.match(first.stdout, /::error file=run\.js,line=1/);
    await writeFile(
      join(temporaryDirectory, "baseline.json"),
      await readFile(reportFile, "utf8"),
      "utf8",
    );

    const second = run({ INPUT_BASELINE: "baseline.json" });
    assert.equal(second.status, 0, second.stdout);
    assert.doesNotMatch(second.stdout, /::error file=/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GitHub Action creates, then updates, one pull request comment", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codediag-comment-"));
  const comments = [];
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(`${request.method} ${request.url.split("?")[0]}`);
      assert.equal(request.headers.authorization, "Bearer test-token");
      let payload = [];
      if (request.url.startsWith("/repos/octo/app/pulls/5/files")) {
        payload = request.url.includes("page=1")
          ? [{ filename: "app/run.js", status: "added" }]
          : [];
      } else if (request.method === "GET") {
        payload = request.url.includes("page=1") ? comments : [];
      } else if (request.method === "POST") {
        comments.push({ id: 11, body: JSON.parse(body).body });
        payload = comments[0];
      } else if (request.method === "PATCH") {
        comments[0].body = JSON.parse(body).body;
        payload = comments[0];
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const run = () =>
    new Promise((done) => {
      const child = spawn(process.execPath, [actionEntry], {
        cwd: temporaryDirectory,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: temporaryDirectory,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: join(temporaryDirectory, "event.json"),
          GITHUB_REPOSITORY: "octo/app",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          INPUT_PATH: "app",
          INPUT_THRESHOLD: "0",
          INPUT_REPORT: join(temporaryDirectory, "report.json"),
          INPUT_SARIF: join(temporaryDirectory, "report.sarif"),
          INPUT_COMMENT: "true",
          "INPUT_GITHUB-TOKEN": "test-token",
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("close", (status) => done({ status, stdout }));
    });

  try {
    await mkdir(join(temporaryDirectory, "app"));
    await writeFile(
      join(temporaryDirectory, "event.json"),
      JSON.stringify({ pull_request: { number: 5 } }),
    );
    await writeFile(join(temporaryDirectory, "app", "package.json"), "{}\n");
    await writeFile(join(temporaryDirectory, "app", "run.js"), "eval(a);\n");

    const first = await run();
    assert.equal(first.status, 0, first.stdout);
    assert.match(first.stdout, /CodeDiag pull request comment created\./);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /^<!-- codediag:pr-comment -->/);
    assert.match(comments[0].body, /`app\/run\.js:1`/);

    const second = await run();
    assert.equal(second.status, 0, second.stdout);
    assert.match(second.stdout, /CodeDiag pull request comment updated\./);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /no change since the last run/);
    assert.deepEqual(requests.slice(-3), [
      "GET /repos/octo/app/pulls/5/files",
      "GET /repos/octo/app/issues/5/comments",
      "PATCH /repos/octo/app/issues/comments/11",
    ]);
  } finally {
    server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the Action bundle does not embed package.json dependencies", async () => {
  // Otherwise every dependency update changes the committed bundle.
  const bundle = await readFile(actionEntry, "utf8");
  const metadata = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const name of Object.keys(metadata.devDependencies)) {
    assert.ok(
      !bundle.includes(`"${name}": "${metadata.devDependencies[name]}"`) &&
        !bundle.includes(
          `${JSON.stringify(name)}: ${JSON.stringify(metadata.devDependencies[name])}`,
        ),
      `${name} is embedded in dist/action.cjs`,
    );
  }
});

test("GitHub Action combines workspace packages with workspaces: true", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codediag-action-mono-"));
  const outputFile = join(workspace, "output.txt");

  try {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    await writeFile(join(workspace, ".gitignore"), ".env\n");
    for (const name of ["api", "web"]) {
      await mkdir(join(workspace, "packages", name, "src"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "packages", name, "package.json"),
        JSON.stringify({ name }),
      );
      await writeFile(
        join(workspace, "packages", name, "src", "index.js"),
        "export const ok = 1;\n",
      );
    }

    const run = (workspaces, inputs = {}) =>
      spawnSync(process.execPath, [actionEntry], {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: "",
          INPUT_PATH: workspaces === "single" ? "packages/api" : ".",
          INPUT_THRESHOLD: "0",
          INPUT_WORKSPACES: workspaces === "single" ? "true" : workspaces,
          INPUT_AUDIT: "false",
          ...inputs,
        },
      });

    const combined = run("true");
    assert.equal(combined.status, 0, combined.stderr || combined.stdout);
    const report = JSON.parse(
      await readFile(join(workspace, "codediag-report.json"), "utf8"),
    );
    assert.deepEqual(
      report.workspace.packages.map((entry) => entry.path),
      ["packages/api", "packages/web"],
    );

    const missing = run("single");
    // An unusable input is an operational failure, not a failed gate.
    assert.equal(missing.status, 2);
    assert.match(
      missing.stdout + missing.stderr,
      /no workspace packages were found/,
    );

    const gated = run("true", { "INPUT_PACKAGE-THRESHOLD": "100" });
    assert.equal(gated.status, 1, gated.stderr || gated.stdout);
    assert.match(
      gated.stdout,
      /::error title=CodeDiag package threshold not met::packages\/api scored \d+, below its package threshold 100\./,
    );
    // Messages keep commas and colons; only properties escape them.
    assert.match(
      gated.stdout,
      /title=CodeDiag missing-scripts::Missing essential scripts \(build, start\/dev\)/,
    );
    const gatedReport = JSON.parse(
      await readFile(join(workspace, "codediag-report.json"), "utf8"),
    );
    assert.deepEqual(
      gatedReport.workspace.packages.map((entry) => entry.threshold),
      [100, 100],
    );

    const strict = run("true", { "INPUT_FAIL-ON": "warning" });
    assert.equal(strict.status, 1);
    assert.match(
      strict.stdout,
      /::error title=CodeDiag fail-on not met::\d+ active findings at or above warning severity \(fail-on: warning\)\./,
    );

    const unused = run("false", { "INPUT_PACKAGE-THRESHOLD": "50" });
    assert.equal(unused.status, 2);
    assert.match(
      unused.stdout + unused.stderr,
      /package-threshold needs workspaces: true/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("GitHub Action reads Git history for removed secrets with secret-history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codediag-action-"));
  const reportFile = join(workspace, "out", "report.json");
  const git = (cwd, ...args) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });

  try {
    git(workspace, "init", "-q");
    git(workspace, "config", "user.name", "CodeDiag");
    git(workspace, "config", "user.email", "codediag@example.com");
    git(workspace, "config", "commit.gpgsign", "false");
    await writeFile(join(workspace, "package.json"), "{}\n", "utf8");
    await writeFile(join(workspace, ".gitignore"), "out/\n", "utf8");
    // Assembled at runtime so this file does not contain a token pattern.
    const key = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");
    await writeFile(join(workspace, "settings.yml"), `key: ${key}\n`, "utf8");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "add settings");
    await rm(join(workspace, "settings.yml"));
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "remove settings");

    const run = (cwd, secretHistory) =>
      spawnSync(process.execPath, [actionEntry], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: cwd,
          GITHUB_OUTPUT: join(workspace, "out", "output.txt"),
          INPUT_PATH: ".",
          INPUT_THRESHOLD: "0",
          INPUT_REPORT: reportFile,
          INPUT_SARIF: join(workspace, "out", "report.sarif"),
          // GitHub keeps the hyphen in an input's variable name.
          "INPUT_SECRET-HISTORY": secretHistory,
        },
      });
    const historyFiles = async () =>
      JSON.parse(await readFile(reportFile, "utf8"))
        .analyzers.flatMap((analyzer) => analyzer.issues)
        .filter((issue) => issue.rule === "secret-in-git-history")
        .map((issue) => issue.file);

    const off = run(workspace, "");
    assert.equal(off.status, 0, off.stderr || off.stdout);
    assert.deepEqual(await historyFiles(), []);

    const on = run(workspace, "true");
    assert.equal(on.status, 0, on.stderr || on.stdout);
    assert.deepEqual(await historyFiles(), ["settings.yml"]);
    assert.doesNotMatch(on.stdout, /checkout is shallow/);
    assert.ok(!on.stdout.includes(key));

    const invalid = run(workspace, "all");
    assert.equal(invalid.status, 2);
    assert.match(
      invalid.stdout + invalid.stderr,
      /secret-history must be true, false, or a number of commits/,
    );

    const clone = join(workspace, "out", "clone");
    git(
      workspace,
      "clone",
      "-q",
      "--depth",
      "1",
      pathToFileURL(workspace).href,
      clone,
    );
    const shallow = run(clone, "10");
    assert.equal(shallow.status, 0, shallow.stderr || shallow.stdout);
    assert.match(
      shallow.stdout,
      /::warning title=CodeDiag secret history::The checkout is shallow/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("GitHub Action compares with a base branch report", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codediag-action-"));
  const outputFile = join(temporaryDirectory, "output.txt");
  const summaryFile = join(temporaryDirectory, "summary.md");
  const reportFile = join(temporaryDirectory, "report.json");
  const baseFile = join(temporaryDirectory, "base.json");

  try {
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: repositoryRoot,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      INPUT_PATH: ".",
      INPUT_THRESHOLD: "0",
      INPUT_REPORT: reportFile,
      INPUT_SARIF: join(temporaryDirectory, "report.sarif"),
    };
    const base = spawnSync(process.execPath, [actionEntry], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
    });
    assert.equal(base.status, 0, base.stderr || base.stdout);
    const baseReport = JSON.parse(await readFile(reportFile, "utf8"));
    baseReport.totalScore = Math.max(0, baseReport.totalScore - 5);
    await writeFile(baseFile, JSON.stringify(baseReport));
    await writeFile(summaryFile, "");

    const compared = spawnSync(process.execPath, [actionEntry], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...env, INPUT_COMPARE: baseFile },
    });
    assert.equal(compared.status, 0, compared.stderr || compared.stdout);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.comparison.newFindings, 0);
    assert.equal(
      report.comparison.scoreDelta,
      report.totalScore - baseReport.totalScore,
    );
    const summary = await readFile(summaryFile, "utf8");
    assert.match(
      summary,
      /Compared with the base report: \d+ → \d+ \(\+\d+(?:\.\d)?\), 0 new, 0 fixed\./,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
