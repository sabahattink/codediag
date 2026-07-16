import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSecurity } from "../src/analyzers/security.js";

test("generic Node packages are not penalized for web middleware", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-security-"));
  try {
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { chalk: "^5.0.0" } }),
    );
    writeFileSync(join(directory, "index.ts"), "export const value = 1;\n");

    const result = await analyzeSecurity(directory);
    assert.equal(result.score, 100);
    assert.equal(
      result.issues.some((issue) => issue.rule === "no-helmet"),
      false,
    );
    assert.equal(
      result.issues.some((issue) => issue.rule === "no-rate-limiting"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
