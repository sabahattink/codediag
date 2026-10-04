import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createScanContext } from "../src/core/scan-context.js";

function withProject(
  files: Record<string, string>,
  run: (directory: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-context-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("file index skips built-in output directories and dot entries at any depth", () => {
  withProject(
    {
      "src/index.ts": "",
      "packages/a/src/index.ts": "",
      "packages/a/node_modules/lib/index.js": "",
      "packages/a/dist/index.js": "",
      "packages/a/coverage/index.js": "",
      "apps/web/.next/server/chunk.js": "",
      "apps/web/.turbo/cache.js": "",
      "apps/web/public/vendor.min.js": "",
      "apps/web/public/app.js.map": "",
      ".github/workflows/script.js": "",
    },
    (directory) => {
      assert.deepEqual(createScanContext(directory).files(), [
        "packages/a/src/index.ts",
        "src/index.ts",
      ]);
    },
  );
});

test("build and out directories are scanned unless .gitignore excludes them", () => {
  withProject(
    {
      ".gitignore": "/build/\n",
      "build/bundle.js": "",
      "src/build/plan.ts": "",
      "app/api/out/route.ts": "",
    },
    (directory) => {
      assert.deepEqual(createScanContext(directory).files(), [
        "app/api/out/route.ts",
        "src/build/plan.ts",
      ]);
    },
  );
});

test("file index honors root, nested, and negated .gitignore rules", () => {
  withProject(
    {
      ".gitignore": "generated/\n*.log.ts\n",
      "src/index.ts": "",
      "src/generated/client.ts": "",
      "src/trace.log.ts": "",
      "packages/a/.gitignore": "*.gen.ts\n!keep.gen.ts\n",
      "packages/a/types.gen.ts": "",
      "packages/a/keep.gen.ts": "",
      "packages/b/types.gen.ts": "",
    },
    (directory) => {
      assert.deepEqual(createScanContext(directory).files(), [
        "packages/a/keep.gen.ts",
        "packages/b/types.gen.ts",
        "src/index.ts",
      ]);
    },
  );
});

test("file index applies .gitignore files from ancestors up to the git root", () => {
  withProject(
    {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".gitignore": "fixtures/\n",
      "packages/.gitignore": "/a/scratch.ts\n",
      "packages/a/src/index.ts": "",
      "packages/a/fixtures/sample.ts": "",
      "packages/a/scratch.ts": "",
    },
    (directory) => {
      assert.deepEqual(
        createScanContext(join(directory, "packages", "a")).files(),
        ["src/index.ts"],
      );
    },
  );
});

test("user ignore entries keep glob semantics relative to the project root", () => {
  withProject(
    {
      "src/index.ts": "",
      "src/legacy/old.ts": "",
      "legacy/root.ts": "",
      "root.generated.ts": "",
      "src/nested.generated.ts": "",
    },
    (directory) => {
      const context = createScanContext(directory, {
        ...loadConfig(directory),
        ignore: ["legacy", "*.generated.ts"],
      });
      assert.deepEqual(context.files(), [
        "src/index.ts",
        "src/legacy/old.ts",
        "src/nested.generated.ts",
      ]);
    },
  );
});

test("file index does not follow symlinked directories or links outside the project", () => {
  const outside = mkdtempSync(join(tmpdir(), "codediag-outside-"));
  try {
    writeFileSync(join(outside, "secret.ts"), "");
    withProject(
      { "src/index.ts": "", "src/shared/util.ts": "" },
      (directory) => {
        symlinkSync(join(directory, "src", "shared"), join(directory, "link"));
        symlinkSync(join(outside, "secret.ts"), join(directory, "src", "x.ts"));
        symlinkSync(
          join(directory, "src", "index.ts"),
          join(directory, "src", "alias.ts"),
        );
        assert.deepEqual(createScanContext(directory).files(), [
          "src/alias.ts",
          "src/index.ts",
          "src/shared/util.ts",
        ]);
      },
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("code files over maxFileSizeKb or with minified lines are skipped and summarized", () => {
  withProject(
    {
      "src/index.ts": "export const ok = true;\n",
      "src/large.ts": "// x\n".repeat(15_000),
      "src/bundle.js": "a();".repeat(10_000),
      "docs/large.md": "x".repeat(10_000),
    },
    (directory) => {
      const context = createScanContext(directory, {
        ...loadConfig(directory),
        maxFileSizeKb: 64,
      });
      assert.deepEqual(context.files(), ["docs/large.md", "src/index.ts"]);
      assert.deepEqual(context.skipped(), {
        total: 2,
        tooLarge: 1,
        minified: 1,
        unreadable: 0,
        files: [
          { file: "src/bundle.js", reason: "minified" },
          { file: "src/large.ts", reason: "too-large" },
        ],
      });
    },
  );
});

test("matchFiles applies include and exclude globs to the shared index", () => {
  withProject(
    {
      "src/users.controller.ts": "",
      "src/users.controller.spec.ts": "",
      "test/app.controller.ts": "",
      "src/users.service.ts": "",
    },
    (directory) => {
      const context = createScanContext(directory);
      assert.deepEqual(
        context.matchFiles("**/*.controller.ts", {
          exclude: ["**/{test,tests}/**"],
        }),
        ["src/users.controller.ts"],
      );
      assert.deepEqual(
        context.matchFiles(["src/*.service.ts", "src/*.spec.ts"]),
        ["src/users.controller.spec.ts", "src/users.service.ts"],
      );
    },
  );
});

test("readText and getSourceFile reuse cached content and one parsed file", () => {
  withProject({ "src/index.ts": "export const value = 1;\n" }, (directory) => {
    const context = createScanContext(directory);
    const first = context.getSourceFile("src/index.ts");
    writeFileSync(join(directory, "src", "index.ts"), "changed\n");

    assert.equal(context.readText("src/index.ts"), "export const value = 1;\n");
    assert.ok(first);
    assert.equal(context.getSourceFile("src/index.ts"), first);
    assert.equal(context.getSourceFile("src/missing.ts"), null);
    assert.equal(context.skipped().unreadable, 1);
  });
});

test("package.json is parsed once and reports missing or invalid metadata", () => {
  withProject({}, (directory) => {
    const missing = createScanContext(directory);
    assert.equal(missing.packageJsonStatus, "missing");
    assert.equal(missing.packageJson, null);

    writeFileSync(join(directory, "package.json"), "[]");
    assert.equal(createScanContext(directory).packageJsonStatus, "invalid");

    writeFileSync(join(directory, "package.json"), '{"name":"app"}');
    const valid = createScanContext(directory);
    assert.equal(valid.packageJsonStatus, "ok");
    assert.equal(valid.packageJson?.name, "app");
    assert.ok(Object.isFrozen(valid));
  });
});

test("analyzers use the scan context instead of their own discovery or parser", () => {
  const analyzerDirectory = join(import.meta.dirname, "..", "src", "analyzers");
  for (const name of readdirSync(analyzerDirectory)) {
    const source = readFileSync(join(analyzerDirectory, name), "utf-8");
    assert.doesNotMatch(source, /from\s+["']glob["']/, `${name} imports glob`);
    assert.doesNotMatch(
      source,
      /\bnew\s+Project\s*\(/,
      `${name} creates a Project`,
    );
  }
});
