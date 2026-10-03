import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildSarif } from "../src/reporters/sarif.js";
import { scan } from "../src/scanner.js";

async function sinkFingerprints(
  directory: string,
): Promise<Array<{ line?: number; fingerprints: string[] }>> {
  const config = loadConfig(directory);
  config.analyzers = {
    api: false,
    security: true,
    dependencies: false,
    testing: false,
    structure: false,
  };
  const result = await scan(directory, config, { interactive: false });
  return buildSarif(result)
    .runs[0].results.filter((finding) =>
      finding.ruleId.endsWith("/unsafe-dynamic-code"),
    )
    .map((finding) => ({
      line: finding.locations?.[0].physicalLocation.region?.startLine,
      fingerprints: Object.values(finding.partialFingerprints),
    }));
}

test("SARIF fingerprints survive code moving to other lines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-fingerprint-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), "{}");
    const body = [
      "export function run(input: string) {",
      "  eval(input);",
      "}",
    ];
    writeFileSync(join(directory, "src", "run.ts"), body.join("\n"));
    const before = await sinkFingerprints(directory);

    writeFileSync(
      join(directory, "src", "run.ts"),
      ["// moved", "", "", ...body].join("\n"),
    );
    const after = await sinkFingerprints(directory);

    assert.equal(before.length, 1);
    assert.equal(before[0].line, 2);
    assert.equal(after[0].line, 5);
    assert.deepEqual(after[0].fingerprints, before[0].fingerprints);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identical findings in one file keep distinct fingerprints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-fingerprint-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(
      join(directory, "src", "run.ts"),
      ["eval(input);", "eval(input);"].join("\n"),
    );

    const findings = await sinkFingerprints(directory);

    assert.equal(findings.length, 2);
    assert.notDeepEqual(findings[0].fingerprints, findings[1].fingerprints);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fingerprints never hash a line that may contain a credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-fingerprint-"));
  const secretFingerprints = async (value: string) => {
    writeFileSync(
      join(directory, "src", "config.ts"),
      `export const config = { password: "${value}" };\n`,
    );
    const result = await scan(directory, loadConfig(directory), {
      interactive: false,
    });
    return result.analyzers
      .flatMap((analyzer) => analyzer.issues)
      .filter((issue) => issue.rule === "hardcoded-secret")
      .map((issue) => issue.fingerprint);
  };
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), "{}");

    const first = await secretFingerprints(`${"first"}-secret-value`);
    const second = await secretFingerprints(`${"other"}-secret-value`);

    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
