import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AuditRunner,
  analyzeDependencies,
  clearAuditCache,
  resolveAuditCommand,
} from "../src/analyzers/dependencies.js";
import {
  describeAdvisories,
  parseAuditAdvisories,
} from "../src/analyzers/audit-advisories.js";
import { createScanContext } from "../src/core/scan-context.js";

const NPM_OUTPUT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: "lodash",
      severity: "high",
      isDirect: true,
      via: [
        {
          source: 1,
          title: "Prototype Pollution in lodash",
          url: "https://github.com/advisories/GHSA-p6mc-m468-83gw",
          severity: "high",
        },
      ],
    },
    "lodash-es": { name: "lodash-es", severity: "high", via: ["lodash"] },
    minimist: {
      name: "minimist",
      severity: "critical",
      via: [{ title: "Prototype Pollution in minimist", url: "https://x/1" }],
    },
  },
  metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0 } },
});

test("npm audit JSON lists affected packages, most severe first", () => {
  assert.deepEqual(parseAuditAdvisories(NPM_OUTPUT), [
    {
      name: "minimist",
      severity: "critical",
      title: "Prototype Pollution in minimist",
      url: "https://x/1",
    },
    {
      name: "lodash",
      severity: "high",
      title: "Prototype Pollution in lodash",
      url: "https://github.com/advisories/GHSA-p6mc-m468-83gw",
    },
    { name: "lodash-es", severity: "high" },
  ]);
});

test("pnpm, Yarn Classic, and Yarn Berry advisories are read", () => {
  assert.deepEqual(
    parseAuditAdvisories(
      JSON.stringify({
        advisories: {
          "1": {
            module_name: "qs",
            severity: "moderate",
            title: "qs vulnerable to Prototype Pollution",
            url: "https://y/qs",
          },
        },
      }),
    ),
    [
      {
        name: "qs",
        severity: "moderate",
        title: "qs vulnerable to Prototype Pollution",
        url: "https://y/qs",
      },
    ],
  );
  assert.deepEqual(
    parseAuditAdvisories(
      [
        JSON.stringify({ type: "info", data: "progress" }),
        JSON.stringify({
          type: "auditAdvisory",
          data: {
            advisory: { module_name: "ws", severity: "high", title: "ReDoS" },
          },
        }),
        JSON.stringify({
          value: "semver",
          children: { Severity: "moderate", Issue: "ReDoS", URL: "https://z" },
        }),
      ].join("\n"),
    ),
    [
      { name: "ws", severity: "high", title: "ReDoS" },
      {
        name: "semver",
        severity: "moderate",
        title: "ReDoS",
        url: "https://z",
      },
    ],
  );
  assert.deepEqual(parseAuditAdvisories("not json at all"), []);
});

test("describeAdvisories lists up to five packages per severity", () => {
  const advisories = Array.from({ length: 7 }, (_, index) => ({
    name: `pkg-${index}`,
    severity: "low" as const,
  }));
  assert.equal(
    describeAdvisories(advisories, "low"),
    " Affected: pkg-0; pkg-1; pkg-2; pkg-3; pkg-4; and 2 more.",
  );
  assert.equal(describeAdvisories(advisories, "high"), "");
});

test("vulnerability findings name affected packages in the fix, not the message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-advisories-"));
  const runner: AuditRunner = () => ({ stdout: NPM_OUTPUT, stderr: "" });
  try {
    clearAuditCache();
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, "package-lock.json"), "{}");
    const result = await analyzeDependencies(createScanContext(directory), {
      runAudit: runner,
    });
    const high = result.issues.find((issue) => issue.rule === "vuln-high");
    assert.equal(high?.message, "2 high severity vulnerabilities");
    assert.equal(
      high?.fix,
      "Run npm audit fix. Affected: lodash (Prototype Pollution in lodash, https://github.com/advisories/GHSA-p6mc-m468-83gw); lodash-es.",
    );
  } finally {
    clearAuditCache();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit: production limits each package manager to production dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-advisories-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}");
    assert.deepEqual(resolveAuditCommand(directory, "npm@10", true).args, [
      "audit",
      "--json",
      "--omit=dev",
    ]);
    assert.deepEqual(resolveAuditCommand(directory, "pnpm@9", true).args, [
      "audit",
      "--json",
      "--prod",
    ]);
    assert.deepEqual(
      resolveAuditCommand(directory, "yarn@1.22.22", true).args,
      ["audit", "--json", "--groups", "dependencies"],
    );
    assert.deepEqual(resolveAuditCommand(directory, "yarn@4.5.0", true).args, [
      "npm",
      "audit",
      "--json",
      "--recursive",
      "--environment",
      "production",
    ]);
    assert.deepEqual(resolveAuditCommand(directory, "npm@10").args, [
      "audit",
      "--json",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
