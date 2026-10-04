import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  changedFiles,
  GitHubRequestError,
  type PullRequestContext,
  pullRequestContext,
  upsertComment,
} from "../src/core/github-pr.js";
import {
  PR_COMMENT_MARKER,
  previousScore,
  renderPrComment,
} from "../src/reporters/pr-comment.js";
import type { DiagnosticIssue, ScanResult } from "../src/types.js";

function result(issues: DiagnosticIssue[], totalScore = 82): ScanResult {
  return {
    project: "api",
    stack: { framework: "express", language: "typescript" },
    analyzers: [{ name: "Security", score: 70, issues, summary: "" }],
    totalScore,
    grade: "B",
    timestamp: "2026-10-04T00:00:00.000Z",
    scoringVersion: 2,
  } as ScanResult;
}

const XSS: DiagnosticIssue = {
  severity: "critical",
  rule: "reflected-xss",
  message: "Request data is written into an HTML response without escaping",
  file: "src/app.ts",
  line: 12,
};
const REDIRECT: DiagnosticIssue = {
  severity: "warning",
  rule: "open-redirect",
  message: "A redirect target comes from request data",
  file: "src/login.ts",
  line: 4,
};
const NO_HELMET: DiagnosticIssue = {
  severity: "warning",
  rule: "no-helmet",
  message: "Helmet middleware is not configured",
};

test("the comment lists findings in changed files and counts the rest", () => {
  const body = renderPrComment({
    result: result([REDIRECT, XSS, NO_HELMET, { ...XSS, file: "src/old.ts" }]),
    threshold: 80,
    previousScore: 85,
    changedFiles: new Set([
      "services/api/src/app.ts",
      "services/api/src/login.ts",
    ]),
    projectDirectory: "services/api",
  });

  assert.ok(
    body.startsWith(`${PR_COMMENT_MARKER}\n<!-- codediag:score=82 -->`),
  );
  assert.match(body, /^## ✅ CodeDiag: 82\/100 \(B\)$/m);
  assert.match(body, /^▼ −3 since the last run · threshold 80$/m);
  assert.match(body, /^\| Security \| 70\/100 \| 4 \|$/m);
  assert.match(body, /### Findings in changed files \(2\)/);
  // Critical findings come first; paths are repository-relative.
  const rows = body
    .split("\n")
    .filter((line) => line.startsWith("| 🔴") || line.startsWith("| 🟡"));
  assert.deepEqual(rows, [
    "| 🔴 | [`reflected-xss`](https://github.com/sabahattink/codediag/blob/main/docs/rules.md#reflected-xss) | `services/api/src/app.ts:12` | Request data is written into an HTML response without escaping |",
    "| 🟡 | [`open-redirect`](https://github.com/sabahattink/codediag/blob/main/docs/rules.md#open-redirect) | `services/api/src/login.ts:4` | A redirect target comes from request data |",
  ]);
  assert.match(body, /Not listed: 2 findings elsewhere in the project\./);
  assert.match(body, /Scanned by \[CodeDiag\]/);
});

test("the comment reports a failed threshold and a clean change", () => {
  const body = renderPrComment({
    result: result([NO_HELMET], 61),
    threshold: 70,
    changedFiles: new Set(["README.md"]),
    projectDirectory: "",
  });

  assert.match(body, /^## ❌ CodeDiag: 61\/100 \(B\)$/m);
  assert.match(body, /^threshold 70$/m);
  assert.match(body, /No findings in the files this pull request changes\./);
  assert.equal(previousScore(body), 61);
  assert.equal(previousScore("unrelated comment"), undefined);
});

test("score changes read as up, down, or unchanged", () => {
  const render = (previous: number) =>
    renderPrComment({
      result: result([], 82),
      threshold: 0,
      previousScore: previous,
      changedFiles: new Set(),
      projectDirectory: "",
    });

  assert.match(render(79.5), /▲ \+2\.5 since the last run/);
  assert.match(render(82), /no change since the last run/);
});

function fakeGitHub(comments: Array<{ id: number; body: string }>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    let payload: unknown = {};
    if (url.includes("/files")) {
      payload =
        page === 1
          ? [
              ...Array.from({ length: 99 }, (_, index) => ({
                filename: `src/f${index}.ts`,
                status: "modified",
              })),
              { filename: "src/gone.ts", status: "removed" },
            ]
          : [{ filename: "src/app.ts", status: "added" }];
    } else if (method === "GET") {
      payload = page === 1 ? comments : [];
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CONTEXT: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repository: "octo/app",
  number: 7,
  token: "token",
};

test("changed files are paginated and exclude removed files", async () => {
  const { fetchImpl } = fakeGitHub([]);
  const files = await changedFiles(CONTEXT, fetchImpl);

  assert.equal(files.size, 100);
  assert.ok(files.has("src/app.ts"));
  assert.ok(!files.has("src/gone.ts"));
});

test("the first run creates the comment and later runs update it", async () => {
  const created = fakeGitHub([{ id: 1, body: "Looks good" }]);
  assert.equal(
    await upsertComment(
      CONTEXT,
      () => `${PR_COMMENT_MARKER}\nnew`,
      created.fetchImpl,
    ),
    "created",
  );
  const post = created.calls.at(-1);
  assert.equal(post?.method, "POST");
  assert.equal(
    post?.url,
    "https://api.github.test/repos/octo/app/issues/7/comments",
  );
  assert.deepEqual(post?.body, { body: `${PR_COMMENT_MARKER}\nnew` });

  const updated = fakeGitHub([
    { id: 1, body: "Looks good" },
    { id: 2, body: `${PR_COMMENT_MARKER}\n<!-- codediag:score=90 -->` },
  ]);
  let seen: string | undefined;
  assert.equal(
    await upsertComment(
      CONTEXT,
      (previous) => {
        seen = previous;
        return "next";
      },
      updated.fetchImpl,
    ),
    "updated",
  );
  assert.equal(previousScore(seen ?? ""), 90);
  const patch = updated.calls.at(-1);
  assert.equal(patch?.method, "PATCH");
  assert.equal(
    patch?.url,
    "https://api.github.test/repos/octo/app/issues/comments/2",
  );
});

test("API errors carry the status code", async () => {
  const fetchImpl = (async () =>
    new Response("{}", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    changedFiles(CONTEXT, fetchImpl),
    (error: unknown) =>
      error instanceof GitHubRequestError && error.status === 403,
  );
});

test("only pull request events have a pull request context", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-event-"));
  try {
    const eventPath = join(directory, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
    const env = {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/app",
    };

    assert.deepEqual(pullRequestContext(env, "t"), {
      apiUrl: "https://api.github.com",
      repository: "octo/app",
      number: 42,
      token: "t",
    });
    assert.equal(
      pullRequestContext({ ...env, GITHUB_EVENT_NAME: "push" }, "t"),
      null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
