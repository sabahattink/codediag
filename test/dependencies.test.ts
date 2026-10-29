import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import { analyzeDependencies } from "../src/analyzers/dependencies.js";
import { parseNpmAuditOutput, runNpmAudit, type AuditRunner } from "../src/analyzers/npm-audit.js";
import { NEST_FIXTURE, cleanAudit, cleanupTempProjects, tempProject } from "./helpers.js";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => {
  cleanupTempProjects();
  vi.mocked(spawnSync).mockReset();
});

const auditWith = (counts: { critical?: number; high?: number; moderate?: number }): AuditRunner => () => ({
  ok: true,
  counts: { critical: 0, high: 0, moderate: 0, low: 0, ...counts },
});

const healthyPkg = JSON.stringify({ scripts: { build: "tsc", start: "node ." }, engines: { node: ">=20" }, dependencies: {} });

describe("analyzeDependencies", () => {
  it("scores 100 for a healthy project with a clean audit", async () => {
    const dir = tempProject({ "package.json": healthyPkg, "package-lock.json": "{}" });
    const result = await analyzeDependencies(dir, { runAudit: cleanAudit });
    expect(result).toMatchObject({ score: 100, issues: [], summary: "5/5 checks passed" });
  });

  it("reports vulnerabilities by severity", async () => {
    const dir = tempProject({ "package.json": healthyPkg, "package-lock.json": "{}" });
    const result = await analyzeDependencies(dir, { runAudit: auditWith({ critical: 2, high: 1, moderate: 3 }) });
    expect(result.issues.map((i) => `${i.severity}:${i.rule}:${i.message}`)).toEqual([
      "critical:vuln-critical:2 critical vulnerabilities",
      "warning:vuln-high:1 high severity vulnerability",
      "info:vuln-moderate:3 moderate vulnerabilities",
    ]);
    expect(result.score).toBe(80);
  });

  it("gives half credit and an info issue when the audit cannot run", async () => {
    const dir = tempProject({ "package.json": healthyPkg, "package-lock.json": "{}" });
    const result = await analyzeDependencies(dir, { runAudit: () => ({ ok: false, reason: "offline" }) });
    expect(result.score).toBe(90);
    expect(result.issues).toEqual([expect.objectContaining({ severity: "info", rule: "audit-unavailable", message: "npm audit could not run: offline" })]);
  });

  it("flags missing lock file, engines, scripts and deprecated packages", async () => {
    const dir = tempProject({ "package.json": JSON.stringify({ dependencies: { request: "^2.88.0" } }) });
    const result = await analyzeDependencies(dir, { runAudit: cleanAudit });
    expect(result.issues.map((i) => i.rule).sort()).toEqual(["deprecated-dep", "missing-scripts", "no-engines", "no-lock-file"]);
    expect(result.score).toBe(20);
  });

  it("finds a lock file in a parent directory (monorepo)", async () => {
    const dir = tempProject({ "package-lock.json": "{}", "packages/app/package.json": healthyPkg });
    const result = await analyzeDependencies(`${dir}/packages/app`, { runAudit: cleanAudit });
    expect(result.issues.map((i) => i.rule)).not.toContain("no-lock-file");
  });

  it("returns 0 for a missing or invalid package.json", async () => {
    expect((await analyzeDependencies(tempProject({}), { runAudit: cleanAudit })).issues[0]?.rule).toBe("no-package-json");
    expect((await analyzeDependencies(tempProject({ "package.json": "[" }), { runAudit: cleanAudit })).issues[0]?.rule).toBe("invalid-package-json");
  });

  it("works on the NestJS fixture without touching the network", async () => {
    const result = await analyzeDependencies(NEST_FIXTURE, { runAudit: cleanAudit });
    expect(result.score).toBe(100);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("parseNpmAuditOutput", () => {
  it("reads metadata.vulnerabilities", () => {
    const stdout = JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4, total: 10 } } });
    expect(parseNpmAuditOutput(stdout)).toEqual({ ok: true, counts: { critical: 4, high: 3, moderate: 2, low: 1 } });
  });

  it("returns the npm error summary (e.g. ENOLOCK)", () => {
    const stdout = JSON.stringify({ error: { code: "ENOLOCK", summary: "This command requires an existing lockfile.\nTry creating one first", detail: "" } });
    expect(parseNpmAuditOutput(stdout)).toEqual({ ok: false, reason: "This command requires an existing lockfile." });
  });

  it("rejects non-JSON and unexpected shapes", () => {
    expect(parseNpmAuditOutput("npm ERR! boom")).toMatchObject({ ok: false });
    expect(parseNpmAuditOutput("[]")).toMatchObject({ ok: false });
    expect(parseNpmAuditOutput("{}")).toMatchObject({ ok: false });
  });
});

describe("runNpmAudit (child_process mocked)", () => {
  it("parses stdout even though npm exits with status 1 when vulnerabilities exist", () => {
    const stdout = JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0 } } });
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, status: 1, signal: null, output: [], stdout, stderr: "" });
    expect(runNpmAudit("/project")).toEqual({ ok: true, counts: { critical: 0, high: 2, moderate: 0, low: 0 } });
    expect(spawnSync).toHaveBeenCalledWith("npm audit --json", expect.objectContaining({ cwd: "/project", shell: true }));
  });

  it("reports a timeout readably", () => {
    const error = Object.assign(new Error("spawnSync cmd.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, status: null, signal: "SIGTERM", output: [], stdout: "", stderr: "", error });
    expect(runNpmAudit("/project")).toEqual({ ok: false, reason: "timed out after 30s" });
  });
});
