import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseAuditSummary,
  resolveAuditCommand,
} from "../src/analyzers/dependencies.js";

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
