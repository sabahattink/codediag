import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { NEST_FIXTURE, NODE_FIXTURE, cleanupTempProjects, copyFixture, tempProject } from "./helpers.js";

/**
 * Runs the built CLI (test/global-setup.ts builds dist first). Fixture copies
 * disable the dependency analyzer so no test spawns `npm audit`.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "index.js");
const OFFLINE_CONFIG = "analyzers:\n  dependencies: false\n";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[], cwd = ROOT): CliRun {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8", env: { ...process.env, FORCE_COLOR: "0" } });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

afterEach(cleanupTempProjects);

describe("codediag CLI (built)", () => {
  it("prints the package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string };
    const res = run(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it("--ci writes clean JSON to stdout and exits 0 at or above the threshold", () => {
    const dir = copyFixture(NEST_FIXTURE, { ".codediag.yml": OFFLINE_CONFIG });
    const res = run(["scan", dir, "--ci", "--threshold", "50"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const report = JSON.parse(res.stdout) as { totalScore: number; analyzers: Array<{ name: string }> };
    expect(report.totalScore).toBeGreaterThanOrEqual(50);
    expect(report.analyzers.map((a) => a.name)).toEqual(["API Health", "Security", "Testing", "Structure"]);
  });

  it("--ci exits 1 below the threshold and keeps stdout parseable", () => {
    const dir = copyFixture(NEST_FIXTURE, { ".codediag.yml": OFFLINE_CONFIG });
    const res = run(["scan", dir, "--ci", "--threshold", "99"]);
    expect(res.status).toBe(1);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toMatch(/is below the threshold of 99/);
  });

  it("--threshold fails the run without --ci (terminal and --quiet)", () => {
    const dir = copyFixture(NEST_FIXTURE, { ".codediag.yml": OFFLINE_CONFIG });
    expect(run(["scan", dir, "--threshold", "99"]).status).toBe(1);
    const quiet = run(["scan", dir, "--quiet", "--threshold", "99"]);
    expect(quiet.status).toBe(1);
    expect(quiet.stdout.trim()).toMatch(/^codediag \d+\/100 [A-F][+]?$/);
  });

  it("--format json and --format md keep stdout free of spinner output", () => {
    const dir = copyFixture(NEST_FIXTURE, { ".codediag.yml": OFFLINE_CONFIG });
    const json = run(["scan", dir, "--format", "json", "--threshold", "0"]);
    expect(json.status).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    const md = run(["scan", dir, "--format", "md", "--threshold", "0"]);
    expect(md.stdout.startsWith("## codediag")).toBe(true);
    expect(md.stderr).toBe("");
  });

  it("uses the threshold from .codediag.yml, overridable by the flag", () => {
    // sample-node: threshold 40, dependencies disabled, vendor/ ignored
    expect(run(["scan", NODE_FIXTURE, "--quiet"]).status).toBe(0);
    expect(run(["scan", NODE_FIXTURE, "--quiet", "--threshold", "95"]).status).toBe(1);
  });

  it("exits 2 with a clear message for an invalid config file", () => {
    const dir = copyFixture(NODE_FIXTURE, { ".codediag.yml": "threshold: high\nanalyzer:\n  api: false\n" });
    const res = run(["scan", dir, "--ci"]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/threshold must be an integer between 0 and 100/);
    expect(res.stderr).toMatch(/Unknown key "analyzer"/);
  });

  it("exits 2 for usage errors and missing directories", () => {
    expect(run(["scan", "--threshold", "abc"]).status).toBe(2);
    expect(run(["scan", "--no-such-flag"]).status).toBe(2);
    const missing = run(["scan", join(ROOT, "does-not-exist")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/Directory not found/);
  });

  it("init writes a config that parses back to the defaults, and does not overwrite it", () => {
    const dir = tempProject({});
    const first = run(["init"], dir);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Created \.codediag\.yml/);
    const configPath = join(dir, ".codediag.yml");
    expect(existsSync(configPath)).toBe(true);
    expect(parseConfig(readFileSync(configPath, "utf-8"))).toEqual(DEFAULT_CONFIG);
    expect(run(["init"], dir).stdout).toMatch(/already exists/);
  });
});
