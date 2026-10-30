import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AsyncAuditRunner,
  type AuditRunner,
  analyzeDependencies,
  clearAuditCache,
  parseAuditSummary,
  prefetchAudits,
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

const HIGH_VULNERABILITIES = JSON.stringify({
  metadata: {
    vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0 },
  },
});

function auditProject(directory: string, withModules = true): void {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      engines: { node: ">=20" },
      scripts: { build: "x", start: "y" },
    }),
  );
  writeFileSync(join(directory, "package-lock.json"), '{"lockfileVersion":3}');
  if (withModules) mkdirSync(join(directory, "node_modules"));
}

function persistedAudits(directory: string): string[] {
  const cache = join(directory, "node_modules", ".cache", "codediag", "audit");
  return existsSync(cache)
    ? readdirSync(cache).map((name) => join(cache, name))
    : [];
}

test("successful audits persist for an hour in node_modules/.cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  let runs = 0;
  const counting: AuditRunner = () => {
    runs++;
    return { stdout: HIGH_VULNERABILITIES, stderr: "" };
  };
  const scanDependencies = (audit?: "cached") => {
    // Each scan starts like a new process, with no audit in memory.
    clearAuditCache();
    return analyzeDependencies(createScanContext(directory), {
      runAudit: counting,
      ...(audit ? { audit } : {}),
    });
  };

  try {
    auditProject(directory);
    const fresh = await scanDependencies();
    assert.deepEqual(
      fresh.issues.map((issue) => issue.rule),
      ["vuln-high"],
    );
    assert.doesNotMatch(fresh.summary, /reused/);
    assert.equal(runs, 1);
    const [file] = persistedAudits(directory);
    assert.ok(file, "the audit result is written to the cache");
    assert.equal(
      readFileSync(file, "utf-8").includes("lockfileVersion"),
      false,
    );

    const reused = await scanDependencies();
    assert.equal(runs, 1);
    assert.deepEqual(
      reused.issues.map((issue) => issue.rule),
      ["vuln-high"],
    );
    assert.match(reused.summary, /; audit reused from less than a minute ago$/);
    // Editor saves, which never run the package manager, reuse it as well.
    assert.deepEqual(
      (await scanDependencies("cached")).issues.map((issue) => issue.rule),
      ["vuln-high"],
    );
    assert.equal(runs, 1);

    const entry = JSON.parse(readFileSync(file, "utf-8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...entry,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    await scanDependencies();
    assert.equal(runs, 2, "an entry older than an hour is not used");

    writeFileSync(persistedAudits(directory)[0] ?? file, "{");
    await scanDependencies();
    assert.equal(runs, 3, "an unreadable entry is replaced");

    writeFileSync(
      persistedAudits(directory)[0] ?? file,
      JSON.stringify({
        ...entry,
        createdAt: new Date().toISOString(),
        summary: { high: "2" },
      }),
    );
    await scanDependencies();
    assert.equal(runs, 4, "an entry with the wrong shape is replaced");
  } finally {
    clearAuditCache();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed audits and projects without node_modules are not persisted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  let runs = 0;
  const failing: AuditRunner = () => {
    runs++;
    return { stdout: "", stderr: "network unreachable" };
  };
  try {
    auditProject(directory);
    for (let scan = 0; scan < 2; scan++) {
      clearAuditCache();
      const result = await analyzeDependencies(createScanContext(directory), {
        runAudit: failing,
      });
      assert.deepEqual(
        result.issues.map((issue) => issue.rule),
        ["audit-unavailable"],
      );
    }
    assert.equal(runs, 2);
    assert.deepEqual(persistedAudits(directory), []);

    rmSync(join(directory, "node_modules"), { recursive: true });
    clearAuditCache();
    await analyzeDependencies(createScanContext(directory), {
      runAudit: () => ({ stdout: HIGH_VULNERABILITIES, stderr: "" }),
    });
    assert.equal(existsSync(join(directory, "node_modules")), false);
  } finally {
    clearAuditCache();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace audits are prefetched concurrently and reused by cached scans", async () => {
  const root = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  const packages = ["a", "b", "c"].map((name) => join(root, name));
  let running = 0;
  let mostAtOnce = 0;
  const started: string[] = [];
  const slow: AsyncAuditRunner = async (_command, cwd) => {
    started.push(cwd);
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running--;
    return { stdout: HIGH_VULNERABILITIES, stderr: "" };
  };
  const unreachable: AuditRunner = () => {
    throw new Error("prefetched scans must not run the package manager");
  };

  try {
    clearAuditCache();
    for (const directory of packages) {
      mkdirSync(directory);
      auditProject(directory, false);
    }
    await prefetchAudits(
      packages.map((projectPath) => ({ projectPath, production: false })),
      { runner: slow, concurrency: 2 },
    );
    assert.equal(started.length, 3);
    assert.equal(mostAtOnce, 2);

    for (const directory of packages) {
      const result = await analyzeDependencies(createScanContext(directory), {
        audit: "cached",
        runAudit: unreachable,
      });
      assert.deepEqual(
        result.issues.map((issue) => issue.rule),
        ["vuln-high"],
      );
    }
  } finally {
    clearAuditCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm workspace packages share one audit and keep their own advisories", async () => {
  const root = mkdtempSync(join(tmpdir(), "codediag-dependencies-"));
  const advisory = (name: string, severity: string, paths: string[]) => ({
    module_name: name,
    severity,
    title: `${name} advisory`,
    url: `https://example.com/${name}`,
    findings: [{ version: "1.0.0", paths }],
  });
  // pnpm prefixes each path with the importer: packages/api is packages__api.
  const output = JSON.stringify({
    advisories: {
      "1": advisory("lodash", "high", ["packages__api>lodash"]),
      "2": advisory("lodash", "moderate", ["packages__api>lodash"]),
      "3": advisory("semver", "high", [
        "packages__api>make-dir>semver",
        "packages__web>semver",
      ]),
      "4": advisory("esbuild", "moderate", [".>esbuild"]),
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 2, high: 2, critical: 0 },
    },
  });
  const cwds: string[] = [];
  const runner: AsyncAuditRunner = async (_command, cwd) => {
    cwds.push(cwd);
    return { stdout: output, stderr: "" };
  };
  const unreachable: AuditRunner = () => {
    throw new Error("the shared audit must be reused");
  };
  const packages = ["api", "web", "docs"].map((name) =>
    join(root, "packages", name),
  );
  const findings = async (directory: string, audit: true | "cached") => {
    const result = await analyzeDependencies(createScanContext(directory), {
      audit,
      runAudit: unreachable,
    });
    return result.issues.map((issue) => `${issue.rule}: ${issue.message}`);
  };

  try {
    clearAuditCache();
    writeFileSync(join(root, "package.json"), '{"private":true}');
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(root, "node_modules"));
    for (const directory of packages) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          engines: { node: ">=20" },
          scripts: { build: "x", start: "y" },
        }),
      );
    }

    await prefetchAudits(
      packages.map((projectPath) => ({ projectPath, production: false })),
      { runner },
    );
    assert.deepEqual(cwds, [root]);

    const expected = [
      [
        "vuln-high: 2 high severity vulnerabilities",
        "vuln-moderate: 1 moderate vulnerability",
      ],
      ["vuln-high: 1 high severity vulnerability"],
      [],
    ];
    for (const [position, directory] of packages.entries()) {
      assert.deepEqual(
        await findings(directory, "cached"),
        expected[position],
        directory,
      );
    }
    // The audit persisted at the lock file keeps the split for later scans.
    clearAuditCache();
    for (const [position, directory] of packages.entries()) {
      assert.deepEqual(
        await findings(directory, true),
        expected[position],
        directory,
      );
    }
  } finally {
    clearAuditCache();
    rmSync(root, { recursive: true, force: true });
  }
});
