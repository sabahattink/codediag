import { describe, it, expect, afterEach } from "vitest";
import { scan } from "../src/scanner.js";
import { loadConfig } from "../src/config.js";
import { calculateGrade, calculateTotalScore } from "../src/scoring.js";
import { DEFAULT_CONFIG, type ProgressReporter } from "../src/types.js";
import { NEST_FIXTURE, NODE_FIXTURE, cleanAudit, cleanupTempProjects, tempProject } from "./helpers.js";

afterEach(cleanupTempProjects);

function recordingProgress(): ProgressReporter & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    start: (t) => { events.push(`start ${t}`); },
    succeed: (t) => { events.push(`ok ${t}`); },
    stop: () => { events.push("stop"); },
  };
}

describe("scan", () => {
  it("runs all five analyzers on the NestJS fixture and computes the weighted total", async () => {
    const result = await scan(NEST_FIXTURE, { runAudit: cleanAudit });
    expect(result.project).toBe("sample-nestjs");
    expect(result.analyzers.map((a) => a.name)).toEqual(["API Health", "Security", "Dependencies", "Testing", "Structure"]);
    expect(result.totalScore).toBe(calculateTotalScore(result.analyzers));
    expect(result.grade).toBe(calculateGrade(result.totalScore));
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it("honours analyzer toggles", async () => {
    const config = { ...DEFAULT_CONFIG, analyzers: { ...DEFAULT_CONFIG.analyzers, api: false, dependencies: false } };
    const result = await scan(NEST_FIXTURE, { config, runAudit: cleanAudit });
    expect(result.analyzers.map((a) => a.name)).toEqual(["Security", "Testing", "Structure"]);
  });

  it("applies the fixture's .codediag.yml: dependencies disabled, vendor/ ignored", async () => {
    const { config } = loadConfig(NODE_FIXTURE);
    const result = await scan(NODE_FIXTURE, { config, runAudit: () => { throw new Error("audit must not run"); } });
    expect(result.analyzers.map((a) => a.name)).toEqual(["Security", "Testing", "Structure"]);
    expect(result.analyzers.flatMap((a) => a.issues).map((i) => i.rule)).not.toContain("hardcoded-secret");
  });

  it("reports progress, including skipped API analysis", async () => {
    const dir = tempProject({ "package.json": JSON.stringify({ dependencies: { next: "^15" } }), "app/page.tsx": "" });
    const progress = recordingProgress();
    await scan(dir, { progress, runAudit: cleanAudit });
    expect(progress.events[0]).toBe("start Detecting project stack...");
    expect(progress.events).toContain("ok Stack: nextjs + javascript");
    expect(progress.events).toContain("ok Analyzing API health: skipped (nothing to analyze)");
    expect(progress.events.some((e) => /^ok Security: \d+\/100$/.test(e))).toBe(true);
    expect(progress.events.at(-1)).toMatch(/^ok Structure: \d+\/100$/);
  });

  it("rejects a missing directory or a file path", async () => {
    await expect(scan("/definitely/not/here")).rejects.toThrow(/Directory not found/);
    const dir = tempProject({ "file.txt": "" });
    await expect(scan(`${dir}/file.txt`)).rejects.toThrow(/Directory not found/);
  });
});
