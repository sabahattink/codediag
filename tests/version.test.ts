import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPackageVersion } from "../src/version.js";

test("CLI version comes from package metadata", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version: string };

  assert.equal(getPackageVersion(), pkg.version);
});
