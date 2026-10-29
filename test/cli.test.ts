import { describe, it, expect } from "vitest";
import { runScanCommand, type ScanCommandDeps, type ScanCommandOptions } from "../src/cli.js";
import { ConfigError, type LoadedConfig } from "../src/config.js";
import { DEFAULT_CONFIG, type CodediagConfig, type ProgressReporter, type ScanResult } from "../src/types.js";
import type { ScanOptions } from "../src/scanner.js";

function fakeResult(totalScore: number): ScanResult {
  return {
    project: "demo",
    stack: {
      framework: "express",
      language: "typescript",
      orm: null,
      hasDocker: false,
      hasEnvFile: false,
      hasPrisma: false,
      hasTests: true,
      packageManager: "npm",
    },
    analyzers: [
      {
        name: "Security",
        score: totalScore,
        summary: "test",
        issues: [{ severity: "warning", rule: "no-helmet", message: "Helmet middleware not detected" }],
      },
    ],
    totalScore,
    grade: "C",
    timestamp: "2026-01-02T03:04:05.000Z",
  };
}

interface Harness {
  deps: ScanCommandDeps;
  stdout: string[];
  stderr: string[];
  progressEnabled: boolean[];
  scanCalls: Array<{ path: string; options: ScanOptions }>;
}

function harness(opts: {
  score?: number;
  config?: CodediagConfig;
  configError?: Error;
  scanError?: Error;
  isTTY?: boolean;
} = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const progressEnabled: boolean[] = [];
  const scanCalls: Array<{ path: string; options: ScanOptions }> = [];
  const noopProgress: ProgressReporter = { start: () => {}, succeed: () => {}, stop: () => {} };

  const deps: ScanCommandDeps = {
    io: {
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
      isTTY: opts.isTTY ?? true,
    },
    loadConfig: (): LoadedConfig => {
      if (opts.configError) throw opts.configError;
      return { config: opts.config ?? DEFAULT_CONFIG, path: opts.config ? "/demo/.codediag.yml" : null };
    },
    scan: async (path, options) => {
      scanCalls.push({ path, options });
      if (opts.scanError) throw opts.scanError;
      return fakeResult(opts.score ?? 80);
    },
    createProgress: (enabled) => {
      progressEnabled.push(enabled);
      return noopProgress;
    },
  };
  return { deps, stdout, stderr, progressEnabled, scanCalls };
}

function options(overrides: Partial<ScanCommandOptions> = {}): ScanCommandOptions {
  return { format: "terminal", ...overrides };
}

describe("runScanCommand exit codes", () => {
  it("exits 0 when the score meets the default threshold", async () => {
    const h = harness({ score: 70 });
    expect(await runScanCommand("demo", options(), h.deps)).toBe(0);
  });

  it("exits 1 below the threshold without --ci (README: --threshold 80 fails below 80)", async () => {
    const h = harness({ score: 75 });
    expect(await runScanCommand("demo", options({ threshold: "80" }), h.deps)).toBe(1);
    expect(h.stderr.join("")).toMatch(/75\/100 is below the threshold of 80/);
  });

  it("exits 1 below the threshold with --quiet (husky pre-push example)", async () => {
    const h = harness({ score: 65 });
    expect(await runScanCommand("demo", options({ quiet: true, threshold: "70" }), h.deps)).toBe(1);
  });

  it("exits 1 below the threshold with --format md", async () => {
    const h = harness({ score: 10 });
    expect(await runScanCommand("demo", options({ format: "md" }), h.deps)).toBe(1);
  });

  it("uses the config threshold when no flag is given", async () => {
    const h = harness({ score: 85, config: { ...DEFAULT_CONFIG, threshold: 90 } });
    expect(await runScanCommand("demo", options(), h.deps)).toBe(1);
  });

  it("lets the --threshold flag override the config file", async () => {
    const h = harness({ score: 85, config: { ...DEFAULT_CONFIG, threshold: 90 } });
    expect(await runScanCommand("demo", options({ threshold: "80" }), h.deps)).toBe(0);
  });

  it("exits 2 for an invalid --threshold without scanning", async () => {
    const h = harness();
    expect(await runScanCommand("demo", options({ threshold: "high" }), h.deps)).toBe(2);
    expect(h.scanCalls).toHaveLength(0);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join("")).toMatch(/--threshold must be an integer between 0 and 100/);
  });

  it("exits 2 for an unknown --format", async () => {
    const h = harness();
    expect(await runScanCommand("demo", options({ format: "xml" }), h.deps)).toBe(2);
    expect(h.stderr.join("")).toMatch(/Unknown format "xml" \(expected terminal, json or md\)/);
  });

  it("exits 2 with the config error message when .codediag.yml is invalid", async () => {
    const h = harness({ configError: new ConfigError('Invalid .codediag.yml:\n  - Unknown key "foo"') });
    expect(await runScanCommand("demo", options({ ci: true }), h.deps)).toBe(2);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join("")).toMatch(/Unknown key "foo"/);
  });

  it("exits 2 when the scan itself fails", async () => {
    const h = harness({ scanError: new Error("Directory not found: /nope") });
    expect(await runScanCommand("demo", options(), h.deps)).toBe(2);
    expect(h.stderr.join("")).toMatch(/Directory not found/);
  });
});

describe("runScanCommand output", () => {
  it("--ci writes only parseable JSON to stdout", async () => {
    const h = harness({ score: 40 });
    const code = await runScanCommand("demo", options({ ci: true, threshold: "50" }), h.deps);
    expect(code).toBe(1);
    const parsed: unknown = JSON.parse(h.stdout.join(""));
    expect(parsed).toMatchObject({ project: "demo", totalScore: 40 });
  });

  it("--ci forces JSON even when another format is requested", async () => {
    const h = harness();
    await runScanCommand("demo", options({ ci: true, format: "md" }), h.deps);
    expect(() => JSON.parse(h.stdout.join(""))).not.toThrow();
  });

  it("--format json writes only parseable JSON to stdout", async () => {
    const h = harness();
    expect(await runScanCommand("demo", options({ format: "json" }), h.deps)).toBe(0);
    expect(() => JSON.parse(h.stdout.join(""))).not.toThrow();
  });

  it("--format md writes the markdown report", async () => {
    const h = harness();
    await runScanCommand("demo", options({ format: "md" }), h.deps);
    expect(h.stdout.join("")).toMatch(/^## codediag/);
  });

  it("--quiet prints only the score line", async () => {
    const h = harness({ score: 80 });
    await runScanCommand("demo", options({ quiet: true }), h.deps);
    const lines = h.stdout.join("").split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/codediag 80\/100/);
  });

  it("enables the spinner only for interactive terminal output", async () => {
    const cases: Array<[Partial<ScanCommandOptions>, boolean, boolean]> = [
      [{}, true, true],
      [{}, false, false],
      [{ quiet: true }, true, false],
      [{ format: "json" }, true, false],
      [{ format: "md" }, true, false],
      [{ ci: true }, true, false],
    ];
    for (const [overrides, isTTY, expected] of cases) {
      const h = harness({ isTTY });
      await runScanCommand("demo", options(overrides), h.deps);
      expect(h.progressEnabled, JSON.stringify({ overrides, isTTY })).toEqual([expected]);
    }
  });

  it("passes the loaded config to the scanner", async () => {
    const config: CodediagConfig = {
      ...DEFAULT_CONFIG,
      ignore: [...DEFAULT_CONFIG.ignore, "vendor"],
      analyzers: { ...DEFAULT_CONFIG.analyzers, dependencies: false },
    };
    const h = harness({ config });
    await runScanCommand("demo", options(), h.deps);
    expect(h.scanCalls).toHaveLength(1);
    expect(h.scanCalls[0]?.options.config).toEqual(config);
  });
});
