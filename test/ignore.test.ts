import { describe, it, expect, afterEach } from "vitest";
import { toGlobIgnore } from "../src/utils/ignore.js";
import { findFiles } from "../src/utils/files.js";
import { cleanupTempProjects, tempProject } from "./helpers.js";

afterEach(cleanupTempProjects);

describe("toGlobIgnore", () => {
  it("matches bare names at any depth", () => {
    expect(toGlobIgnore(["node_modules"])).toEqual(["**/node_modules", "**/node_modules/**"]);
  });

  it("anchors paths containing a slash to the project root", () => {
    expect(toGlobIgnore(["test/fixtures/", "./build", "/out"])).toEqual([
      "test/fixtures", "test/fixtures/**", "build", "build/**", "out", "out/**",
    ]);
  });

  it("keeps glob entries with a slash as-is and normalizes backslashes", () => {
    expect(toGlobIgnore(["**/*.generated.ts", "src\\legacy", "tmp/**"])).toEqual([
      "**/*.generated.ts", "**/*.generated.ts/**", "src/legacy", "src/legacy/**", "tmp/**",
    ]);
  });

  it("matches slash-less globs at any depth", () => {
    expect(toGlobIgnore(["*.log"])).toEqual(["**/*.log", "**/*.log/**"]);
  });

  it("skips blank entries", () => {
    expect(toGlobIgnore(["", "  "])).toEqual([]);
  });
});

describe("findFiles", () => {
  it("returns sorted POSIX paths and honours ignore entries", async () => {
    const dir = tempProject({
      "src/b.ts": "",
      "src/a.ts": "",
      "src/gen/x.generated.ts": "",
      "vendor/lib.ts": "",
      "packages/app/node_modules/dep/index.ts": "",
    });
    expect(await findFiles(dir, "**/*.ts", ["node_modules"])).toEqual([
      "src/a.ts", "src/b.ts", "src/gen/x.generated.ts", "vendor/lib.ts",
    ]);
    expect(await findFiles(dir, "**/*.ts", ["node_modules", "vendor", "**/*.generated.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
