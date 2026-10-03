import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scanner.js";

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function rulesFor(
  result: Awaited<ReturnType<typeof scan>>,
  file: string,
): string[] {
  return result.analyzers
    .flatMap((analyzer) => analyzer.issues)
    .filter((issue) => issue.file === file)
    .map((issue) => issue.rule)
    .sort();
}

function findingFiles(
  result: Awaited<ReturnType<typeof scan>>,
): Array<string | undefined> {
  return result.analyzers.flatMap((analyzer) =>
    analyzer.issues.map((issue) => issue.file),
  );
}

const VULNERABLE_SOURCE = [
  "eval(input);",
  // Built at runtime so this test file does not itself contain a secret.
  `const apiKey = "${"abcdefgh".repeat(4)}";`,
  "export const password = save({ password: input });",
].join("\n");

test("scan ignores dependency and build directories at any depth", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-discovery-"));
  try {
    writeFiles(directory, {
      "package.json": JSON.stringify({ name: "mono", devDependencies: {} }),
      ".gitignore": ".env\n",
      "src/index.ts": "export const ok = true;\n",
      "packages/a/src/vulnerable.js": VULNERABLE_SOURCE,
      "packages/a/node_modules/lib/index.js": VULNERABLE_SOURCE,
      "packages/a/dist/index.js": VULNERABLE_SOURCE,
      "packages/a/build/index.js": VULNERABLE_SOURCE,
      "packages/a/out/index.js": VULNERABLE_SOURCE,
      "packages/a/coverage/lcov-report/index.js": VULNERABLE_SOURCE,
      "packages/a/src/vendor.min.js": VULNERABLE_SOURCE,
    });

    const config = { ...loadConfig(directory), threshold: 0 };
    config.analyzers.dependencies = false;
    const result = await scan(directory, config, { interactive: false });

    // The same content is reported where it is first-party source.
    assert.deepEqual(rulesFor(result, "packages/a/src/vulnerable.js"), [
      "hardcoded-secret",
      "password-hashing-not-detected",
      "unsafe-dynamic-code",
    ]);
    assert.deepEqual(
      findingFiles(result).filter(
        (file) =>
          file?.startsWith("packages/") &&
          file !== "packages/a/src/vulnerable.js",
      ),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scan honors .gitignore and skips bundled or oversized sources", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-discovery-"));
  try {
    const minified = `${"var a=1;".repeat(8000)}\n${VULNERABLE_SOURCE}`;
    writeFiles(directory, {
      "package.json": JSON.stringify({ name: "app", devDependencies: {} }),
      ".gitignore": ".env\nextension-bundle/\n",
      "src/index.ts": "export const ok = true;\n",
      "extension-bundle/extension.cjs": VULNERABLE_SOURCE,
      "vendor/bundle.js": minified,
      "vendor/huge.js": `${VULNERABLE_SOURCE}\n${"// padding\n".repeat(60_000)}`,
    });

    const config = { ...loadConfig(directory), threshold: 0 };
    config.analyzers.dependencies = false;
    const result = await scan(directory, config, { interactive: false });

    assert.deepEqual(
      findingFiles(result).filter(
        (file) =>
          file?.startsWith("extension-bundle/") || file?.startsWith("vendor/"),
      ),
      [],
    );
    assert.deepEqual(result.skipped, {
      total: 2,
      tooLarge: 1,
      minified: 1,
      unreadable: 0,
      files: [
        { file: "vendor/bundle.js", reason: "minified" },
        { file: "vendor/huge.js", reason: "too-large" },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
