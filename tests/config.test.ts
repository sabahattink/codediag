import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  failOnMessage,
  findingsAtOrAbove,
  isBelowThreshold,
  loadConfig,
  normalizeIgnorePatterns,
  parseFailOn,
  parseSecretHistory,
  parseThreshold,
} from "../src/config.js";
import type { AnalyzerResult } from "../src/types.js";

function withProject(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-config-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("loads validated analyzer settings and ignore patterns", () => {
  withProject((directory) => {
    writeFileSync(
      join(directory, ".codediag.yml"),
      [
        "threshold: 82",
        "ignore:",
        "  - generated",
        "analyzers:",
        "  api: false",
        "  security: true",
      ].join("\n"),
    );

    const config = loadConfig(directory);
    assert.equal(config.threshold, 82);
    assert.deepEqual(config.ignore, ["generated"]);
    assert.equal(config.analyzers.api, false);
    assert.equal(config.analyzers.security, true);
    assert.equal(config.analyzers.dependencies, true);
  });
});

test("rejects invalid and unknown configuration", () => {
  withProject((directory) => {
    writeFileSync(join(directory, ".codediag.yml"), "threshold: 101\n");
    assert.throws(() => loadConfig(directory), /threshold must be an integer/);

    writeFileSync(join(directory, ".codediag.yml"), "futureOption: true\n");
    assert.throws(() => loadConfig(directory), /unknown option/);
  });
});

test("loads and validates maxFileSizeKb", () => {
  withProject((directory) => {
    assert.equal(loadConfig(directory).maxFileSizeKb, 512);

    writeFileSync(join(directory, ".codediag.yml"), "maxFileSizeKb: 2048\n");
    assert.equal(loadConfig(directory).maxFileSizeKb, 2048);

    for (const value of ["0", "1.5", '"512"']) {
      writeFileSync(
        join(directory, ".codediag.yml"),
        `maxFileSizeKb: ${value}\n`,
      );
      assert.throws(
        () => loadConfig(directory),
        /maxFileSizeKb must be an integer/,
      );
    }
  });
});

test("loads and validates the scoring version", () => {
  withProject((directory) => {
    assert.deepEqual(loadConfig(directory).scoring, { version: 2 });

    writeFileSync(join(directory, ".codediag.yml"), "scoring:\n  version: 1\n");
    assert.deepEqual(loadConfig(directory).scoring, { version: 1 });

    for (const [content, message] of [
      ["scoring:\n  version: 3\n", /scoring.version must be 1 or 2/],
      ["scoring: 2\n", /scoring must be an object/],
      ["scoring:\n  weights: {}\n", /unknown scoring option: weights/],
    ] as const) {
      writeFileSync(join(directory, ".codediag.yml"), content);
      assert.throws(() => loadConfig(directory), message);
    }
  });
});

test("loads and validates per-rule settings", () => {
  withProject((directory) => {
    assert.deepEqual(loadConfig(directory).rules, {});

    writeFileSync(
      join(directory, ".codediag.yml"),
      "rules:\n  missing-swagger: off\n  open-cors: critical\n",
    );
    assert.deepEqual(loadConfig(directory).rules, {
      "missing-swagger": "off",
      "open-cors": "critical",
    });

    for (const [content, message] of [
      ["rules:\n  no-such-rule: off\n", /unknown rule: no-such-rule/],
      ["rules:\n  open-cors: error\n", /rules.open-cors must be one of/],
      ["rules: [open-cors]\n", /rules must be a map/],
    ] as const) {
      writeFileSync(join(directory, ".codediag.yml"), content);
      assert.throws(() => loadConfig(directory), message);
    }
  });
});

test("normalizes directories without corrupting glob patterns", () => {
  assert.deepEqual(normalizeIgnorePatterns(["dist", "generated/**"]), [
    "dist",
    "dist/**",
    "generated/**",
  ]);
});

test("threshold parsing and comparison are deterministic", () => {
  assert.equal(parseThreshold("80"), 80);
  assert.equal(isBelowThreshold(79, 80), true);
  assert.equal(isBelowThreshold(80, 80), false);
  assert.throws(() => parseThreshold("80x"), /threshold must be an integer/);
});

test("loads and validates the workspace package threshold", () => {
  withProject((directory) => {
    assert.equal(loadConfig(directory).packageThreshold, null);
    writeFileSync(join(directory, ".codediag.yml"), "packageThreshold: 60\n");
    assert.equal(loadConfig(directory).packageThreshold, 60);
    for (const value of ["101", "-1", "6.5", '"60"']) {
      writeFileSync(
        join(directory, ".codediag.yml"),
        `packageThreshold: ${value}\n`,
      );
      assert.throws(
        () => loadConfig(directory),
        /packageThreshold must be an integer between 0 and 100/,
      );
    }
  });
});

test("loads and validates the audit switch", () => {
  withProject((directory) => {
    assert.equal(loadConfig(directory).audit, true);
    writeFileSync(join(directory, ".codediag.yml"), "audit: false\n");
    assert.equal(loadConfig(directory).audit, false);
    writeFileSync(join(directory, ".codediag.yml"), "audit: production\n");
    assert.equal(loadConfig(directory).audit, "production");
    writeFileSync(join(directory, ".codediag.yml"), "audit: sometimes\n");
    assert.throws(
      () => loadConfig(directory),
      /audit must be true, false, or production/,
    );
  });
});

test("loads and validates the fail-on severity", () => {
  withProject((directory) => {
    assert.equal(loadConfig(directory).failOn, null);
    for (const severity of ["critical", "warning", "info"]) {
      writeFileSync(join(directory, ".codediag.yml"), `failOn: ${severity}\n`);
      assert.equal(loadConfig(directory).failOn, severity);
    }
    writeFileSync(join(directory, ".codediag.yml"), "failOn: error\n");
    assert.throws(
      () => loadConfig(directory),
      /failOn must be critical, warning, or info/,
    );
  });
  assert.equal(parseFailOn("warning"), "warning");
  assert.throws(
    () => parseFailOn("high"),
    /must be critical, warning, or info/,
  );
});

test("fail-on counts active findings at or above the severity", () => {
  const analyzers = [
    {
      name: "Security",
      score: 50,
      summary: "",
      issues: [
        { severity: "critical", rule: "a", message: "a" },
        { severity: "warning", rule: "b", message: "b" },
        { severity: "info", rule: "c", message: "c" },
        {
          severity: "critical",
          rule: "d",
          message: "d",
          suppression: { kind: "inSource", justification: "reviewed" },
        },
        { severity: "critical", rule: "e", message: "e", baseline: true },
      ],
    },
  ] satisfies AnalyzerResult[];

  assert.deepEqual(
    findingsAtOrAbove(analyzers, "critical").map((issue) => issue.rule),
    ["a"],
  );
  assert.deepEqual(
    findingsAtOrAbove(analyzers, "warning").map((issue) => issue.rule),
    ["a", "b"],
  );
  assert.equal(findingsAtOrAbove(analyzers, "info").length, 3);
  assert.equal(findingsAtOrAbove(analyzers, null).length, 0);
  assert.equal(
    failOnMessage(2, "warning"),
    "2 active findings at or above warning severity",
  );
  assert.equal(
    failOnMessage(1, "critical"),
    "1 active finding at or above critical severity",
  );
});

test("loads and validates the secret history setting", () => {
  withProject((directory) => {
    const write = (value: string) =>
      writeFileSync(
        join(directory, ".codediag.yml"),
        `secretHistory: ${value}\n`,
      );
    assert.equal(loadConfig(directory).secretHistory, false);
    write("false");
    assert.equal(loadConfig(directory).secretHistory, false);
    write("true");
    assert.equal(loadConfig(directory).secretHistory, 1000);
    write("250");
    assert.equal(loadConfig(directory).secretHistory, 250);
    for (const invalid of ["0", "-5", "2.5", "100001", "all", '"500"']) {
      write(invalid);
      assert.throws(
        () => loadConfig(directory),
        /Invalid \.codediag\.yml: secretHistory must be true, false, or a number of commits from 1 to 100000/,
        invalid,
      );
    }
  });
});

test("parses the --secret-history commit count", () => {
  assert.equal(parseSecretHistory(true), 1000);
  assert.equal(parseSecretHistory("40"), 40);
  for (const invalid of ["", "0", "1e3", "12abc", "100001", "."]) {
    assert.throws(
      () => parseSecretHistory(invalid),
      /--secret-history must be a number of commits from 1 to 100000/,
      invalid,
    );
  }
});
