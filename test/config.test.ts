import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  loadConfig,
  parseConfig,
  parseThreshold,
  resolveThreshold,
} from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codediag-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseConfig", () => {
  it("returns the defaults for an empty file", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("# only a comment\n")).toEqual(DEFAULT_CONFIG);
  });

  it("parses the template written by `codediag init` back to the defaults", () => {
    expect(parseConfig(CONFIG_TEMPLATE)).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial config over the defaults", () => {
    const config = parseConfig("threshold: 85\nanalyzers:\n  testing: false\n");
    expect(config.threshold).toBe(85);
    expect(config.analyzers).toEqual({ ...DEFAULT_CONFIG.analyzers, testing: false });
    expect(config.ignore).toEqual(DEFAULT_CONFIG.ignore);
  });

  it("adds user ignore entries to the built-in ones without duplicates", () => {
    const config = parseConfig("ignore: [dist, test/fixtures, '**/*.generated.ts']\n");
    expect(config.ignore).toEqual([...DEFAULT_CONFIG.ignore, "test/fixtures", "**/*.generated.ts"]);
  });

  it("treats keys with no value as unset", () => {
    expect(parseConfig("threshold:\nignore:\nanalyzers:\n")).toEqual(DEFAULT_CONFIG);
  });

  it("rejects malformed YAML with the source name and position", () => {
    expect(() => parseConfig("threshold: [70\n", "my.yml")).toThrowError(ConfigError);
    expect(() => parseConfig("threshold: [70\n", "my.yml")).toThrowError(/my\.yml: invalid YAML/);
    expect(() => parseConfig("threshold: [70\n", "my.yml")).toThrowError(/line \d+/);
  });

  it("rejects duplicate keys", () => {
    expect(() => parseConfig("threshold: 70\nthreshold: 80\n")).toThrowError(/invalid YAML/);
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parseConfig("- threshold\n- 70\n")).toThrowError(/must be a mapping/);
    expect(() => parseConfig("70\n")).toThrowError(/must be a mapping/);
  });

  it("rejects unknown top-level keys and lists the allowed ones", () => {
    expect(() => parseConfig("treshold: 80\n")).toThrowError(
      /Unknown key "treshold" \(allowed: threshold, ignore, analyzers\)/
    );
  });

  it("rejects unknown analyzer names", () => {
    expect(() => parseConfig("analyzers:\n  lint: true\n")).toThrowError(
      /Unknown analyzer "lint" \(allowed: api, security, dependencies, testing, structure\)/
    );
  });

  it.each([
    ["threshold: 101\n"],
    ["threshold: -1\n"],
    ["threshold: 70.5\n"],
    ["threshold: '80'\n"],
    ["threshold: true\n"],
  ])("rejects an out-of-range or non-integer threshold: %s", (text) => {
    expect(() => parseConfig(text)).toThrowError(/threshold must be an integer between 0 and 100/);
  });

  it("rejects an ignore value that is not a list of non-empty strings", () => {
    expect(() => parseConfig("ignore: dist\n")).toThrowError(/ignore must be a list of strings/);
    expect(() => parseConfig("ignore: [dist, 3]\n")).toThrowError(/ignore\[1\] must be a non-empty string/);
    expect(() => parseConfig("ignore: ['  ']\n")).toThrowError(/ignore\[0\] must be a non-empty string/);
  });

  it("rejects non-boolean analyzer toggles", () => {
    expect(() => parseConfig("analyzers:\n  security: 'no'\n")).toThrowError(/analyzers\.security must be true or false/);
    expect(() => parseConfig("analyzers: [api]\n")).toThrowError(/analyzers must be a mapping/);
  });

  it("rejects a config that disables every analyzer", () => {
    const text = "analyzers:\n  api: false\n  security: false\n  dependencies: false\n  testing: false\n  structure: false\n";
    expect(() => parseConfig(text)).toThrowError(/at least one analyzer must be enabled/);
  });

  it("reports every problem at once", () => {
    try {
      parseConfig("threshold: 500\nfoo: 1\nanalyzers:\n  bar: true\n", ".codediag.yml");
      expect.unreachable("parseConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toMatch(/^Invalid \.codediag\.yml:/);
      expect(message).toMatch(/threshold must be/);
      expect(message).toMatch(/Unknown key "foo"/);
      expect(message).toMatch(/Unknown analyzer "bar"/);
    }
  });
});

describe("loadConfig", () => {
  it("returns the defaults and no path when the project has no config file", () => {
    const dir = makeTempDir();
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, path: null });
  });

  it("loads .codediag.yml from the scanned directory", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".codediag.yml"), "threshold: 90\n");
    const loaded = loadConfig(dir);
    expect(loaded.path).toBe(join(dir, ".codediag.yml"));
    expect(loaded.config.threshold).toBe(90);
  });

  it("also accepts the .yaml extension", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".codediag.yaml"), "threshold: 55\n");
    expect(loadConfig(dir).config.threshold).toBe(55);
  });

  it("refuses to guess when both .yml and .yaml exist", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".codediag.yml"), "threshold: 90\n");
    writeFileSync(join(dir, ".codediag.yaml"), "threshold: 50\n");
    expect(() => loadConfig(dir)).toThrowError(/Both \.codediag\.yml and \.codediag\.yaml/);
  });

  it("names the offending file in validation errors", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".codediag.yml"), "colour: blue\n");
    expect(() => loadConfig(dir)).toThrowError(/Invalid .*\.codediag\.yml:[\s\S]*Unknown key "colour"/);
  });
});

describe("threshold precedence", () => {
  it("parses a valid CLI threshold", () => {
    expect(parseThreshold("0")).toBe(0);
    expect(parseThreshold("80")).toBe(80);
    expect(parseThreshold("100")).toBe(100);
  });

  it.each(["abc", "", "80.5", "-5", "101", "1e2", " 80"])("rejects an invalid CLI threshold %j", (value) => {
    expect(() => parseThreshold(value)).toThrowError(/--threshold must be an integer between 0 and 100/);
  });

  it("uses the CLI flag over the config file", () => {
    expect(resolveThreshold("90", { ...DEFAULT_CONFIG, threshold: 40 })).toBe(90);
  });

  it("uses the config file when no flag is given", () => {
    expect(resolveThreshold(undefined, { ...DEFAULT_CONFIG, threshold: 40 })).toBe(40);
  });

  it("falls back to the default threshold", () => {
    expect(resolveThreshold(undefined, DEFAULT_CONFIG)).toBe(70);
  });
});
