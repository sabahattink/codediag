import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { detectWorkspaces } from "../src/core/workspaces.js";

function withProject(
  files: Record<string, string>,
  run: (directory: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "codediag-workspaces-"));
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

const pkg = (name: string) => JSON.stringify({ name });

test("npm workspaces expand globs to directories with a package.json", () => {
  withProject(
    {
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*", "apps/web", "!packages/legacy"],
      }),
      "package-lock.json": "{}",
      "packages/api/package.json": pkg("@acme/api"),
      "packages/ui/package.json": pkg("@acme/ui"),
      "packages/legacy/package.json": pkg("@acme/legacy"),
      "packages/notes/README.md": "no manifest here",
      "apps/web/package.json": pkg("web"),
      "apps/docs/package.json": pkg("docs"),
      "packages/api/node_modules/dep/package.json": pkg("dep"),
    },
    (directory) => {
      assert.deepEqual(detectWorkspaces(directory), {
        tool: "npm",
        packages: [
          { path: "apps/web", name: "web" },
          { path: "packages/api", name: "@acme/api" },
          { path: "packages/ui", name: "@acme/ui" },
        ],
      });
    },
  );
});

test("Yarn's object form, pnpm-workspace.yaml, and lerna.json are read", () => {
  withProject(
    {
      "package.json": JSON.stringify({
        private: true,
        workspaces: { packages: ["libs/**"] },
      }),
      "yarn.lock": "",
      "libs/a/package.json": pkg("a"),
      "libs/group/b/package.json": pkg("b"),
    },
    (directory) => {
      assert.deepEqual(detectWorkspaces(directory), {
        tool: "yarn",
        packages: [
          { path: "libs/a", name: "a" },
          { path: "libs/group/b", name: "b" },
        ],
      });
    },
  );

  withProject(
    {
      "package.json": pkg("root"),
      "pnpm-workspace.yaml":
        "packages:\n  - 'services/*'\n  - '!services/sandbox'\n",
      "services/billing/package.json": pkg("billing"),
      "services/sandbox/package.json": pkg("sandbox"),
    },
    (directory) => {
      assert.deepEqual(detectWorkspaces(directory), {
        tool: "pnpm",
        packages: [{ path: "services/billing", name: "billing" }],
      });
    },
  );

  withProject(
    {
      "package.json": pkg("root"),
      "lerna.json": JSON.stringify({ version: "1.0.0" }),
      "packages/core/package.json": pkg("core"),
    },
    (directory) => {
      assert.deepEqual(detectWorkspaces(directory), {
        tool: "lerna",
        packages: [{ path: "packages/core", name: "core" }],
      });
    },
  );
});

test("Turborepo and Nx are named when they orchestrate the workspaces", () => {
  withProject(
    {
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "turbo.json": "{}",
      "apps/site/package.json": pkg("site"),
    },
    (directory) => {
      assert.equal(detectWorkspaces(directory)?.tool, "turbo");
    },
  );

  withProject(
    {
      "package.json": pkg("root"),
      "nx.json": "{}",
      "apps/api/project.json": JSON.stringify({ name: "api" }),
      "apps/api/package.json": pkg("api-package"),
      "libs/shared/project.json": JSON.stringify({ name: "shared" }),
    },
    (directory) => {
      assert.deepEqual(detectWorkspaces(directory), {
        tool: "nx",
        packages: [
          { path: "apps/api", name: "api-package" },
          { path: "libs/shared", name: "shared" },
        ],
      });
    },
  );
});

test("projects without workspaces return null", () => {
  withProject({ "package.json": pkg("single") }, (directory) => {
    assert.equal(detectWorkspaces(directory), null);
  });
  withProject(
    { "package.json": JSON.stringify({ workspaces: ["packages/*"] }) },
    (directory) => {
      assert.equal(detectWorkspaces(directory), null);
    },
  );
});
