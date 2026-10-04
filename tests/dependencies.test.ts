import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AuditRunner,
  analyzeDependencies,
  clearAuditCache,
  parseAuditSummary,
  resolveAuditCommand,
} from "../src/analyzers/dependencies.js";
import { createScanContext } from "../src/core/scan-context.js";

function withTempProject(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("parses vulnerability counts from a non-zero npm audit result", () => {
  const summary = parseAuditSummary(
    JSON.stringify({
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 1,
          moderate: 2,
          high: 3,
          critical: 4,
          total: 10,
        },
      },
    }),
  );

  assert.deepEqual(summary, {
    critical: 4,
    high: 3,
    moderate: 2,
    low: 1,
  });
});

test("parses Yarn Classic NDJSON audit summaries", () => {
  const summary = parseAuditSummary(
    [
      JSON.stringify({
        type: "auditAdvisory",
        data: { advisory: { severity: "high" } },
      }),
      JSON.stringify({
        type: "auditSummary",
        data: {
          vulnerabilities: {
            info: 0,
            low: 1,
            moderate: 0,
            high: 2,
            critical: 0,
          },
        },
      }),
    ].join("\n"),
  );

  assert.deepEqual(summary, {
    critical: 0,
    high: 2,
    moderate: 0,
    low: 1,
  });
});

test("rejects audit JSON without a vulnerability summary", () => {
  assert.throws(
    () => parseAuditSummary("{}"),
    /did not include a vulnerability summary/,
  );
  assert.throws(() => parseAuditSummary("not-json"), /invalid JSON/);
  assert.throws(
    () =>
      parseAuditSummary(
        JSON.stringify({
          metadata: {
            vulnerabilities: {
              critical: 0,
              high: "0",
              moderate: 0,
              low: 0,
            },
          },
        }),
      ),
    /invalid high vulnerability count/,
  );
});

test("selects pnpm from packageManager before conflicting lock files", () => {
  withTempProject((directory) => {
    writeFileSync(join(directory, "package-lock.json"), "{}");
    writeFileSync(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const command = resolveAuditCommand(directory, "pnpm@10.0.0");

    assert.equal(command.manager, "pnpm");
    assert.deepEqual(command.args, ["audit", "--json"]);
    assert.equal(command.fixCommand, "pnpm audit --fix");
  });
});

test("selects modern Yarn audit from package metadata", () => {
  withTempProject((directory) => {
    writeFileSync(join(directory, "yarn.lock"), "");
    const command = resolveAuditCommand(directory, "yarn@4.6.0");

    assert.equal(command.manager, "yarn");
    assert.deepEqual(command.args, ["npm", "audit", "--json", "--recursive"]);
  });
});

test("selects Yarn Classic audit for a classic lockfile", () => {
  withTempProject((directory) => {
    writeFileSync(join(directory, "yarn.lock"), "");
    const command = resolveAuditCommand(directory);

    assert.equal(command.manager, "yarn");
    assert.deepEqual(command.args, ["audit", "--json"]);
  });
});

test("detects a monorepo pnpm lockfile", () => {
  withTempProject((directory) => {
    const workspace = join(directory, "apps", "api");
    writeFileSync(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    mkdirSync(workspace, { recursive: true });

    const command = resolveAuditCommand(workspace);
    assert.equal(command.manager, "pnpm");
  });
});

test("detects modern Yarn configuration at the monorepo root", () => {
  withTempProject((directory) => {
    const workspace = join(directory, "packages", "web");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(directory, "yarn.lock"), "");
    writeFileSync(join(directory, ".yarnrc.yml"), "nodeLinker: node-modules\n");

    const command = resolveAuditCommand(workspace);
    assert.equal(command.manager, "yarn");
    assert.deepEqual(command.args, ["npm", "audit", "--json", "--recursive"]);
  });
});

test("a missing lock file skips the audit and reports one clear finding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "app",
        engines: { node: ">=20" },
        scripts: { build: "tsc", start: "node ." },
      }),
    );

    const result = await analyzeDependencies(createScanContext(directory));

    assert.deepEqual(
      result.issues.map((finding) => finding.rule),
      ["no-lock-file"],
    );
    assert.match(result.issues[0].message, /cannot be audited/);
    // The skipped audit still counts as a failed check in the analyzer score.
    assert.equal(result.score, 60);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audits can be skipped by config or scan option without network access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "app",
        engines: { node: ">=20" },
        scripts: { build: "tsc", start: "node ." },
      }),
    );
    writeFileSync(join(directory, "package-lock.json"), "{}");
    writeFileSync(join(directory, ".codediag.yml"), "audit: false\n");

    const configured = await analyzeDependencies(createScanContext(directory));
    assert.deepEqual(
      configured.issues.map((issue) => [issue.rule, issue.severity]),
      [["audit-skipped", "info"]],
    );
    // A deliberately skipped audit is not a failed check in the v1 score.
    assert.equal(configured.score, 100);

    rmSync(join(directory, ".codediag.yml"));
    const optedOut = await analyzeDependencies(createScanContext(directory), {
      audit: false,
    });
    assert.deepEqual(
      optedOut.issues.map((issue) => issue.rule),
      ["audit-skipped"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cached audits reuse an earlier result for the same lock file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  const vulnerable: AuditRunner = () => ({
    stdout: JSON.stringify({
      metadata: {
        vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0 },
      },
    }),
    stderr: "",
  });
  const unreachable: AuditRunner = () => {
    throw new Error("cached scans must not run the package manager");
  };
  const rules = (result: Awaited<ReturnType<typeof analyzeDependencies>>) =>
    result.issues.map((issue) => issue.rule);

  try {
    clearAuditCache();
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        engines: { node: ">=20" },
        scripts: { build: "x", start: "y" },
      }),
    );
    writeFileSync(
      join(directory, "package-lock.json"),
      '{"lockfileVersion":3}',
    );
    const context = () => createScanContext(directory);

    assert.deepEqual(
      rules(
        await analyzeDependencies(context(), {
          audit: "cached",
          runAudit: unreachable,
        }),
      ),
      ["audit-skipped"],
    );
    assert.deepEqual(
      rules(await analyzeDependencies(context(), { runAudit: vulnerable })),
      ["vuln-high"],
    );
    assert.deepEqual(
      rules(
        await analyzeDependencies(context(), {
          audit: "cached",
          runAudit: unreachable,
        }),
      ),
      ["vuln-high"],
    );

    // A changed lock file invalidates the cached result.
    writeFileSync(
      join(directory, "package-lock.json"),
      '{"lockfileVersion":3,"x":1}',
    );
    assert.deepEqual(
      rules(
        await analyzeDependencies(context(), {
          audit: "cached",
          runAudit: unreachable,
        }),
      ),
      ["audit-skipped"],
    );
  } finally {
    clearAuditCache();
    rmSync(directory, { recursive: true, force: true });
  }
});
