import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig, packagesBelowThreshold } from "../src/config.js";
import { packageIgnores, scanWorkspace } from "../src/core/workspace-scan.js";
import { detectWorkspaces } from "../src/core/workspaces.js";
import type { ScanResult } from "../src/types.js";

const EVAL = "export const run = (code: string) => eval(code);\n";

async function withWorkspace(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-monorepo-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const MONOREPO = {
  "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  ".gitignore": ".env\n",
  ".codediag.yml": [
    "ignore:",
    "  - packages/api/generated/**",
    "analyzers:",
    "  dependencies: false",
    "  testing: false",
  ].join("\n"),
  "packages/api/package.json": JSON.stringify({ name: "@acme/api" }),
  "packages/api/src/run.ts": EVAL,
  "packages/api/generated/client.ts": EVAL,
  "packages/web/package.json": JSON.stringify({ name: "@acme/web" }),
  "packages/web/src/run.ts": EVAL,
  "packages/web/src/ok.ts": "export const ok = 1;\n",
};

async function scanMonorepo(
  directory: string,
  options: Parameters<typeof scanWorkspace>[3] = {},
): Promise<ScanResult> {
  const info = detectWorkspaces(directory);
  assert.ok(info);
  return scanWorkspace(directory, loadConfig(directory), info, {
    interactive: false,
    audit: false,
    ...options,
  });
}

test("a workspace scan combines packages with findings located in the workspace", async () => {
  await withWorkspace(MONOREPO, async (directory) => {
    const result = await scanMonorepo(directory);

    assert.deepEqual(
      result.workspace?.packages.map(({ path, name, findings }) => ({
        path,
        name,
        hasFindings: findings > 0,
      })),
      [
        { path: "packages/api", name: "@acme/api", hasFindings: true },
        { path: "packages/web", name: "@acme/web", hasFindings: true },
      ],
    );
    assert.equal(result.workspace?.tool, "npm");

    const security = result.analyzers.find((a) => a.name === "Security");
    assert.ok(security);
    const evals = security.issues.filter(
      (issue) => issue.rule === "unsafe-dynamic-code",
    );
    // The root ignore entry is rebased into the api package.
    assert.deepEqual(
      evals.map((issue) => issue.file),
      ["packages/api/src/run.ts", "packages/web/src/run.ts"],
    );
    // Identical findings in two packages keep distinct fingerprints.
    assert.notEqual(evals[0]?.fingerprint, evals[1]?.fingerprint);
    assert.match(
      security.summary,
      /^2 packages; lowest: packages\/\w+ \(\d+\)$/,
    );
    assert.ok(
      result.analyzers.every((analyzer) =>
        analyzer.issues.every((issue) => issue.file?.startsWith("packages/")),
      ),
    );
  });
});

test("combined analyzer scores average the packages and keep their breakdown", async () => {
  await withWorkspace(MONOREPO, async (directory) => {
    const result = await scanMonorepo(directory);
    const packageScores = result.workspace?.packages.map((p) => p.totalScore);
    assert.equal(packageScores?.length, 2);
    for (const analyzer of result.analyzers) {
      const lost = (analyzer.scoreBreakdown ?? []).reduce(
        (sum, entry) => sum + entry.penalty,
        0,
      );
      // Penalties add up to the loss, up to rounding and the floor at 0.
      assert.ok(
        Math.abs(100 - analyzer.score - lost) <= 1 || analyzer.score === 0,
      );
    }
  });
});

test("baselines and changed-file scopes apply across packages", async () => {
  await withWorkspace(MONOREPO, async (directory) => {
    const first = await scanMonorepo(directory);
    const fingerprints = new Set(
      first.analyzers.flatMap((analyzer) =>
        analyzer.issues.flatMap((issue) =>
          issue.fingerprint ? [issue.fingerprint] : [],
        ),
      ),
    );
    const accepted = await scanMonorepo(directory, { baseline: fingerprints });
    assert.deepEqual(accepted.baseline, {
      matched: fingerprints.size,
      fixed: 0,
    });
    assert.equal(accepted.totalScore, 100);

    const scoped = await scanMonorepo(directory, {
      scope: {
        changedSince: "main",
        files: new Set(["packages/web/src/run.ts", "README.md"]),
      },
    });
    assert.deepEqual(
      scoped.analyzers.flatMap((analyzer) =>
        analyzer.issues.map((issue) => issue.file),
      ),
      ["packages/web/src/run.ts"],
    );
    assert.equal(scoped.scope?.files, 1);
    assert.equal(scoped.scope?.changedSince, "main");
  });
});

test("package thresholds come from the scan, a package's config, or the root", async () => {
  await withWorkspace(
    {
      ...MONOREPO,
      ".codediag.yml": `${MONOREPO[".codediag.yml"]}\npackageThreshold: 100`,
      "packages/web/.codediag.yml": [
        "packageThreshold: 10",
        "analyzers:",
        "  dependencies: false",
      ].join("\n"),
    },
    async (directory) => {
      const configured = await scanMonorepo(directory);
      assert.deepEqual(
        configured.workspace?.packages.map(({ path, threshold }) => ({
          path,
          threshold,
        })),
        [
          { path: "packages/api", threshold: 100 },
          { path: "packages/web", threshold: 10 },
        ],
      );
      assert.ok(configured.workspace);
      assert.deepEqual(
        packagesBelowThreshold(configured.workspace).map((entry) => entry.path),
        ["packages/api"],
      );

      const overridden = await scanMonorepo(directory, { packageThreshold: 0 });
      assert.ok(overridden.workspace);
      assert.deepEqual(
        overridden.workspace.packages.map((entry) => entry.threshold),
        [0, 0],
      );
      assert.deepEqual(packagesBelowThreshold(overridden.workspace), []);
    },
  );
  await withWorkspace(MONOREPO, async (directory) => {
    const result = await scanMonorepo(directory);
    assert.equal(
      result.workspace?.packages.some((entry) => "threshold" in entry),
      false,
    );
  });
});

test("root ignore entries are rebased into each package", () => {
  assert.deepEqual(
    packageIgnores(
      [
        "node_modules",
        "packages/api/generated/**",
        "packages/web/legacy",
        "**/fixtures/**",
        "docs/**",
      ],
      "packages/api",
    ),
    ["node_modules", "generated/**", "**/fixtures/**"],
  );
});
