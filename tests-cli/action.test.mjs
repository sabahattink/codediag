import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
