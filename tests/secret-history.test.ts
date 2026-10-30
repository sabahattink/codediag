import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  parseGitLog,
  scanSecretHistory,
} from "../src/analyzers/secret-history.js";
import { analyzeSecurity } from "../src/analyzers/security.js";
import { loadConfig } from "../src/config.js";
import { createScanContext } from "../src/core/scan-context.js";
import { renderFixPlan } from "../src/reporters/fix-plan.js";
import { renderHtml } from "../src/reporters/html.js";
import { buildSarif } from "../src/reporters/sarif.js";
import { renderTerminal } from "../src/reporters/terminal.js";
import { scan } from "../src/scanner.js";
import type { DiagnosticIssue } from "../src/types.js";

// Assembled at runtime so this file does not itself contain token patterns.
const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");
const OTHER_AWS_KEY = ["AKIA", "Z7Q2W9E4R1T6", "Y3U8"].join("");
const GITHUB_TOKEN = [
  "ghp_",
  "x".repeat(4),
  "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6",
].join("");
const STRONG_PASSWORD = ["V9xkq2", "LmX7pR", "zT4wQe"].join("");
const KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const KEY_BODY = Array.from({ length: 6 }, (_, index) =>
  createHash("sha512")
    .update(`codediag-${index}`)
    .digest("base64")
    .slice(0, 64),
);
const PEM_KEY = [
  `-----BEGIN ${KEY_LABEL}-----`,
  ...KEY_BODY,
  `-----END ${KEY_LABEL}-----`,
  "",
].join("\n");

const HISTORY_RULES = new Set([
  "secret-in-git-history",
  "secret-history-incomplete",
]);

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface Repository {
  directory: string;
  /** Writes (or, for null, deletes) files and commits everything; returns the SHA. */
  commit(files: Record<string, string | null>, date: string): string;
}

function createRepository(directory: string): Repository {
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "CodeDiag");
  git(directory, "config", "user.email", "codediag@example.com");
  git(directory, "config", "commit.gpgsign", "false");
  git(directory, "config", "core.autocrlf", "false");
  // A global excludes file must not hide fixtures such as .env.
  git(
    directory,
    "config",
    "core.excludesFile",
    join(directory, ".git", "none"),
  );
  return {
    directory,
    commit(files, date) {
      for (const [name, content] of Object.entries(files)) {
        const file = join(directory, name);
        if (content === null) {
          rmSync(file, { force: true });
          continue;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      git(directory, "add", "-A", ".");
      execFileSync("git", ["commit", "-q", "-m", `change ${date}`], {
        cwd: directory,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
          GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
        },
      });
      return git(directory, "rev-parse", "HEAD");
    },
  };
}

async function withRepository(
  run: (repository: Repository) => Promise<void> | void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-history-"));
  try {
    await run(createRepository(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function securityScan(
  projectPath: string,
  secretHistory: false | number,
) {
  const result = await analyzeSecurity(createScanContext(projectPath), {
    secretHistory,
  });
  return {
    summary: result.summary,
    issues: result.issues,
    history: result.issues
      .filter((issue) => HISTORY_RULES.has(issue.rule))
      .map(({ rule, severity, file, line, message }) => ({
        rule,
        severity,
        file,
        line,
        message,
      })),
  };
}

const short = (sha: string) => sha.slice(0, 7);

test("parseGitLog reads each commit's added lines per file and hunk", () => {
  const output = [
    "\u0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2024-03-05T09:30:00+04:00",
    "",
    "diff --git a/config.json b/config.json",
    "index 1111111..2222222 100644",
    "--- a/config.json",
    "+++ b/config.json",
    "@@ -2 +2,2 @@",
    '-  "old": 1',
    '+  "new": 2,',
    "+++ b/not-a-header",
    "@@ -9,0 +11 @@ context text",
    "+last line\r",
    "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed",
    "diff --git a/logo.png b/logo.png",
    "Binary files /dev/null and b/logo.png differ",
    "\u0000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2023-12-31T23:00:00-05:00",
    "",
    "diff --git a/sub dir/a b.txt b/sub dir/a b.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/sub dir/a b.txt\t",
    "@@ -0,0 +1 @@",
    "+hello",
    'diff --git "a/we\\"ird\\303\\244.txt" "b/we\\"ird\\303\\244.txt"',
    "--- /dev/null",
    '+++ "b/we\\"ird\\303\\244.txt"',
    "@@ -0,0 +1 @@",
    "+quoted",
    "",
  ].join("\n");

  assert.deepEqual(parseGitLog(output), {
    commits: [
      { sha: "a".repeat(40), date: "2024-03-05" },
      { sha: "b".repeat(40), date: "2023-12-31" },
    ],
    additions: [
      {
        commit: 0,
        file: "config.json",
        lines: ['  "new": 2,', "++ b/not-a-header"],
      },
      { commit: 0, file: "config.json", lines: ["last line"] },
      { commit: 1, file: "sub dir/a b.txt", lines: ["hello"] },
      { commit: 1, file: 'we"irdä.txt', lines: ["quoted"] },
    ],
  });
});

test("parseGitLog drops the last commit of truncated output", () => {
  const output = [
    "\u0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2024-03-05T09:30:00Z",
    "",
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "\u0000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2024-03-04T09:30:00Z",
    "",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1,3 +1,3 @@",
    "-x",
  ].join("\n");

  assert.deepEqual(parseGitLog(output, false), {
    commits: [{ sha: "a".repeat(40), date: "2024-03-05" }],
    additions: [{ commit: 0, file: "a.txt", lines: ["y"] }],
  });
});

test("a removed secret is reported once per file, at the commit that first added it", async () => {
  await withRepository(async (repository) => {
    const first = repository.commit(
      {
        "README.md": "# app\n",
        "config/production.json": JSON.stringify(
          { aws: { accessKeyId: AWS_KEY } },
          null,
          2,
        ),
        ".env": `PORT=3000\nSESSION_SECRET=${STRONG_PASSWORD}\n`,
      },
      "2024-01-10",
    );
    repository.commit(
      { "config/production.json": '{ "aws": {} }\n' },
      "2024-02-10",
    );
    repository.commit(
      {
        "config/production.json": JSON.stringify({ accessKeyId: AWS_KEY }),
      },
      "2024-03-10",
    );
    repository.commit({ "config/production.json": null }, "2024-04-10");
    // The .env file leaves Git but stays on disk with the same secret.
    git(repository.directory, "rm", "-q", "--cached", ".env");
    repository.commit({ ".gitignore": ".env\n" }, "2024-05-10");

    const { history, issues } = await securityScan(repository.directory, 1000);

    assert.deepEqual(history, [
      {
        rule: "secret-in-git-history",
        severity: "critical",
        file: ".env",
        line: undefined,
        message: `A secret value for SESSION_SECRET was committed to .env in ${short(first)} (2024-01-10) and remains in Git history after its removal`,
      },
      {
        rule: "secret-in-git-history",
        severity: "critical",
        file: "config/production.json",
        line: undefined,
        message: `An AWS access key was committed to config/production.json in ${short(first)} (2024-01-10) and remains in Git history after its removal`,
      },
    ]);
    const serialized = JSON.stringify(issues);
    assert.ok(!serialized.includes(AWS_KEY));
    assert.ok(!serialized.includes(STRONG_PASSWORD));
  });
});

test("secrets still in the current tree are left to the current-tree rules", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      { "config/app.json": `{ "token": "${GITHUB_TOKEN}" }\n` },
      "2024-01-10",
    );
    repository.commit(
      {
        "config/app.json": null,
        "config/other.json": `{ "token": "${GITHUB_TOKEN}" }\n`,
      },
      "2024-02-10",
    );

    const { history, issues } = await securityScan(repository.directory, 1000);

    assert.deepEqual(history, []);
    assert.deepEqual(
      issues
        .filter((issue) => issue.rule === "hardcoded-secret")
        .map((issue) => issue.file),
      ["config/other.json"],
    );
  });
});

test("a private key is identified by its key material, in PEM and JSON alike", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      {
        "certs/server.key": PEM_KEY,
        "src/pem.ts": `export const isKey = (text: string) => text.startsWith("-----BEGIN ${KEY_LABEL}-----");\nexport const other = 1;\n`,
        "certs/old.pem": PEM_KEY.replace(KEY_BODY[0] ?? "", "A".repeat(64)),
      },
      "2024-01-10",
    );
    repository.commit(
      {
        "certs/server.key": null,
        "src/pem.ts": null,
        "certs/old.pem": null,
        "config/service-account.json": `${JSON.stringify({ private_key: PEM_KEY })}\n`,
      },
      "2024-02-10",
    );

    const { history } = await securityScan(repository.directory, 1000);

    // server.key's key now lives in the JSON file; the code only names the
    // BEGIN line. Only the other, removed key remains.
    assert.deepEqual(
      history.map(({ file, message }) => ({
        file,
        kind: message.split(" was ")[0],
      })),
      [{ file: "certs/old.pem", kind: "A private key" }],
    );
  });
});

test("ignored paths, dependency folders, and lock files are not read", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      {
        ".codediag.yml": "ignore:\n  - fixtures/**\n",
        "fixtures/keys.json": `{ "key": "${AWS_KEY}" }\n`,
        "node_modules/lib/config.json": `{ "key": "${AWS_KEY}" }\n`,
        "dist/bundle.js": `const key = "${AWS_KEY}";\n`,
        "package-lock.json": `{ "token": "${GITHUB_TOKEN}" }\n`,
      },
      "2024-01-10",
    );
    repository.commit(
      {
        "fixtures/keys.json": null,
        "node_modules/lib/config.json": null,
        "dist/bundle.js": null,
        "package-lock.json": "{}\n",
      },
      "2024-02-10",
    );

    assert.deepEqual(
      (await securityScan(repository.directory, 1000)).history,
      [],
    );
  });
});

test("the commit limit bounds how far back history is read", async () => {
  await withRepository(async (repository) => {
    repository.commit({ "settings.yml": `key: ${AWS_KEY}\n` }, "2024-01-10");
    repository.commit({ "settings.yml": "key: none\n" }, "2024-02-10");
    repository.commit({ "README.md": "# app\n" }, "2024-03-10");

    const limited = await securityScan(repository.directory, 2);
    assert.deepEqual(limited.history, []);
    assert.match(
      limited.summary,
      /; Git history: the most recent 2 commits scanned$/,
    );

    const complete = await securityScan(repository.directory, 3);
    assert.equal(complete.history.length, 1);
    assert.match(complete.summary, /; Git history: 3 commits scanned$/);
  });
});

test("a project in a subdirectory reads only its own history, relative to itself", async () => {
  await withRepository(async (repository) => {
    const first = repository.commit(
      {
        "config.json": `{ "key": "${OTHER_AWS_KEY}" }\n`,
        "packages/api/config.json": `{ "key": "${AWS_KEY}" }\n`,
        "packages/api/package.json": '{ "name": "api" }\n',
      },
      "2024-01-10",
    );
    repository.commit(
      {
        "config.json": "{}\n",
        "packages/api/config.json": "{}\n",
      },
      "2024-02-10",
    );
    repository.commit({ "README.md": "# monorepo\n" }, "2024-03-10");

    const { history, summary } = await securityScan(
      join(repository.directory, "packages", "api"),
      1000,
    );

    assert.deepEqual(
      history.map(({ file, message }) => ({ file, message })),
      [
        {
          file: "config.json",
          message: `An AWS access key was committed to config.json in ${short(first)} (2024-01-10) and remains in Git history after its removal`,
        },
      ],
    );
    // The root-only README commit does not count.
    assert.match(summary, /Git history: 2 commits scanned$/);
  });
});

test("outside a repository or before the first commit, history is skipped silently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-history-"));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(directory);
  try {
    writeFileSync(join(directory, "settings.yml"), "name: app\n");
    const outside = await securityScan(directory, 1000);
    assert.deepEqual(outside.history, []);
    assert.doesNotMatch(outside.summary, /Git history/);

    git(directory, "init", "-q");
    const empty = await securityScan(directory, 1000);
    assert.deepEqual(empty.history, []);
    assert.doesNotMatch(empty.summary, /Git history/);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a shallow clone says that history is partial and names its oldest commit", async () => {
  await withRepository(async (repository) => {
    repository.commit({ "README.md": "# app\n" }, "2024-01-10");
    const boundary = repository.commit(
      { "settings.yml": `key: ${AWS_KEY}\n` },
      "2024-02-10",
    );
    repository.commit({ "settings.yml": null }, "2024-03-10");

    const clone = join(repository.directory, "clone");
    execFileSync(
      "git",
      [
        "clone",
        "-q",
        "--depth",
        "2",
        pathToFileURL(repository.directory).href,
        clone,
      ],
      { stdio: "ignore" },
    );

    const { history, summary } = await securityScan(clone, 1000);

    assert.deepEqual(
      history.map(({ message }) => message),
      [
        `An AWS access key was in settings.yml at ${short(boundary)} (2024-02-10), the oldest commit of this shallow clone, and remains in Git history after its removal`,
      ],
    );
    assert.match(
      summary,
      /Git history: 2 commits scanned; shallow clone, so history is partial$/,
    );
  });
});

test("a scan that reaches the output limit reports what it covered", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      { "data.txt": `${"filler line\n".repeat(2000)}` },
      "2024-01-10",
    );
    const removed = repository.commit(
      { "settings.yml": `key: ${AWS_KEY}\n` },
      "2024-02-10",
    );
    repository.commit({ "settings.yml": null }, "2024-03-10");

    const result = scanSecretHistory(
      createScanContext(repository.directory),
      1000,
      { maxBytes: 4096, timeoutMs: 60_000 },
    );

    assert.deepEqual(
      result.issues.map(({ rule, severity, message }) => ({
        rule,
        severity,
        message,
      })),
      [
        {
          rule: "secret-in-git-history",
          severity: "critical",
          message: `An AWS access key was committed to settings.yml in ${short(removed)} (2024-02-10) and remains in Git history after its removal`,
        },
        {
          rule: "secret-history-incomplete",
          severity: "info",
          message:
            "The Git history scan stopped at its output limit after 2 commits; older commits were not checked for removed secrets",
        },
      ],
    );
    assert.equal(
      result.note,
      "Git history: 2 commits scanned before the output limit",
    );
  });
});

async function historyScan(directory: string, baseline?: ReadonlySet<string>) {
  const config = loadConfig(directory);
  config.analyzers = {
    api: false,
    security: true,
    dependencies: false,
    testing: false,
    structure: false,
  };
  return scan(directory, config, { interactive: false, baseline });
}

function historyIssues(
  result: Awaited<ReturnType<typeof historyScan>>,
): DiagnosticIssue[] {
  return result.analyzers
    .flatMap((analyzer) => analyzer.issues)
    .filter((issue) => issue.rule === "secret-in-git-history");
}

test("the configuration enables the scan; fingerprints are stable and baselines accept findings", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      {
        ".codediag.yml": "secretHistory: true\n",
        "package.json": '{ "name": "app" }\n',
        "config/a.json": `{\n  "first": "${AWS_KEY}",\n  "second": "${OTHER_AWS_KEY}"\n}\n`,
      },
      "2024-01-10",
    );
    repository.commit({ "config/a.json": null }, "2024-02-10");

    const first = historyIssues(await historyScan(repository.directory));
    const second = historyIssues(await historyScan(repository.directory));
    assert.equal(first.length, 2, "one finding per secret and file");
    assert.notEqual(first[0]?.fingerprint, first[1]?.fingerprint);
    assert.match(first[0]?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(
      second.map((issue) => issue.fingerprint),
      first.map((issue) => issue.fingerprint),
    );

    repository.commit(
      { "config/b.json": `{ "first": "${AWS_KEY}" }\n` },
      "2024-03-10",
    );
    repository.commit({ "config/b.json": null }, "2024-04-10");
    const later = historyIssues(await historyScan(repository.directory));

    assert.deepEqual(
      later.map((issue) => issue.file),
      ["config/a.json", "config/a.json", "config/b.json"],
    );
    assert.deepEqual(
      later.slice(0, 2).map((issue) => issue.fingerprint),
      first.map((issue) => issue.fingerprint),
    );

    const accepted = historyIssues(
      await historyScan(
        repository.directory,
        new Set(later.flatMap((issue) => issue.fingerprint ?? [])),
      ),
    );
    assert.deepEqual(
      accepted.map((issue) => issue.baseline),
      [true, true, true],
    );
  });
});

test("reports locate a finding in a file that no longer exists by path only", async () => {
  await withRepository(async (repository) => {
    repository.commit(
      {
        ".codediag.yml": "secretHistory: 10\n",
        "package.json": '{ "name": "app" }\n',
        "config/old.json": `{ "key": "${AWS_KEY}" }\n`,
      },
      "2024-01-10",
    );
    repository.commit({ "config/old.json": null }, "2024-02-10");
    const result = await historyScan(repository.directory);

    const sarif = buildSarif(result).runs[0]?.results.find((finding) =>
      finding.ruleId.endsWith("/secret-in-git-history"),
    );
    assert.deepEqual(sarif?.locations, [
      { physicalLocation: { artifactLocation: { uri: "config/old.json" } } },
    ]);
    assert.match(renderHtml(result), /config\/old\.json/);
    assert.match(renderFixPlan(result), /Location: config\/old\.json\n/);

    const original = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.join(" "));
    };
    try {
      renderTerminal(result, { verbose: true });
    } finally {
      console.log = original;
    }
    const terminal = stripVTControlCharacters(lines.join("\n"));
    assert.match(terminal, /config\/old\.json(?!:)/);
    assert.ok(!terminal.includes(AWS_KEY));
  });
});
