import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { changedFilesSince, limitToFiles } from "../src/core/changed-files.js";
import { scan } from "../src/scanner.js";
import type { AnalyzerResult } from "../src/types.js";

function git(directory: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=CodeDiag",
      "-c",
      "user.email=codediag@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: directory, stdio: "ignore" },
  );
}

function write(directory: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A repository with a base commit and a feature branch on top of it. */
function withRepository(run: (directory: string) => Promise<void> | void) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "codediag-changed-"));
    try {
      git(directory, "init", "-q", "-b", "main");
      write(directory, {
        ".gitignore": "node_modules\n.env\n",
        "app/package.json": '{ "name": "app" }\n',
        "app/src/kept.ts": "export const run = (code: string) => eval(code);\n",
        "app/src/edited.ts": "export const edited = 1;\n",
        "app/src/removed.ts": "export const removed = 1;\n",
        "other/src/index.ts": "export const other = 1;\n",
      });
      git(directory, "add", ".");
      git(directory, "commit", "-q", "-m", "base");
      git(directory, "checkout", "-q", "-b", "feature");
      write(directory, {
        "app/src/edited.ts": "export const edited = 2;\n",
        "other/src/index.ts": "export const other = 2;\n",
      });
      rmSync(join(directory, "app/src/removed.ts"));
      git(directory, "commit", "-q", "-am", "change");
      write(directory, {
        "app/src/staged.ts": "export const staged = 1;\n",
        "app/src/untracked.ts": "export const untracked = 1;\n",
        "app/node_modules/lib/index.js": "",
      });
      git(directory, "add", "app/src/staged.ts");
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test(
  "changed files include commits since the merge base, staged, and untracked files",
  withRepository((directory) => {
    assert.deepEqual(
      [...changedFilesSince(join(directory, "app"), "main")].sort(),
      ["src/edited.ts", "src/staged.ts", "src/untracked.ts"],
    );
    assert.deepEqual([...changedFilesSince(directory, "main")].sort(), [
      "app/src/edited.ts",
      "app/src/staged.ts",
      "app/src/untracked.ts",
      "other/src/index.ts",
    ]);
  }),
);

test(
  "unknown or option-like revisions fail with a clear error",
  withRepository((directory) => {
    assert.throws(
      () => changedFilesSince(directory, "no-such-branch"),
      /Cannot list files changed since "no-such-branch"/,
    );
    assert.throws(
      () => changedFilesSince(directory, "--output=x"),
      /Invalid Git revision/,
    );
  }),
);

test(
  "a scoped scan reports and scores only findings in changed files",
  withRepository(async (directory) => {
    write(directory, {
      "app/src/edited.ts": "export const run = (code: string) => eval(code);\n",
    });
    const project = join(directory, "app");
    const result = await scan(project, undefined, {
      interactive: false,
      audit: false,
      scope: {
        changedSince: "main",
        files: changedFilesSince(project, "main"),
      },
    });
    const located = result.analyzers.flatMap((analyzer) =>
      analyzer.issues.map((issue) => `${issue.rule} ${issue.file ?? ""}`),
    );
    assert.deepEqual(located, ["unsafe-dynamic-code src/edited.ts"]);
    assert.equal(result.scope?.changedSince, "main");
    assert.equal(result.scope?.files, 3);
    assert.ok((result.scope?.excludedFindings ?? 0) > 1);
  }),
);

test("limitToFiles drops findings outside the files and project-level ones", () => {
  const results: AnalyzerResult[] = [
    {
      name: "Security",
      score: 0,
      summary: "",
      issues: [
        { severity: "critical", rule: "a", message: "a", file: "src/x.ts" },
        { severity: "warning", rule: "b", message: "b", file: "src/y.ts" },
        { severity: "warning", rule: "c", message: "c" },
      ],
    },
  ];
  const limited = limitToFiles(results, new Set(["src/x.ts"]));
  assert.deepEqual(
    limited.results[0]?.issues.map((issue) => issue.rule),
    ["a"],
  );
  assert.equal(limited.excluded, 2);
});
