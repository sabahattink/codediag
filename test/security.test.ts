import { describe, it, expect, afterEach } from "vitest";
import { analyzeSecurity } from "../src/analyzers/security.js";
import {
  EXPRESS_FIXTURE,
  NEST_FIXTURE,
  NODE_FIXTURE,
  cleanupTempProjects,
  contextFor,
  tempProject,
} from "./helpers.js";

afterEach(cleanupTempProjects);

// Secret-looking strings are assembled at runtime so this test file itself
// never contains a literal that the scanner (or a push-protection hook) flags.
const fakeStripe = ["sk", "live", "a".repeat(24)].join("_");
const fakeGithub = `ghp_${"b".repeat(36)}`;
const passwordKey = ["pass", "word"].join("");

function rules(result: Awaited<ReturnType<typeof analyzeSecurity>>): string[] {
  return result.issues.map((i) => i.rule);
}

describe("analyzeSecurity", () => {
  it("flags the planted fake API key in the NestJS fixture with file and line", async () => {
    const result = await analyzeSecurity(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    const secrets = result.issues.filter((i) => i.rule === "hardcoded-secret");
    expect(secrets).toEqual([
      expect.objectContaining({ severity: "critical", message: "Possible API Key found in source code", file: "src/config/app.config.ts", line: 5 }),
    ]);
  });

  it("runs the server checks for NestJS: helmet found, wildcard CORS flagged", async () => {
    const result = await analyzeSecurity(NEST_FIXTURE, contextFor(NEST_FIXTURE));
    expect(rules(result)).not.toContain("no-helmet");
    expect(result.issues).toContainEqual(expect.objectContaining({ rule: "open-cors", file: "src/main.ts" }));
    expect(rules(result)).toContain("no-rate-limiting");
    expect(result.summary).toBe("2/6 checks passed");
    expect(result.score).toBe(33);
  });

  it("detects helmet via require() and cors() without options in Express apps", async () => {
    const result = await analyzeSecurity(EXPRESS_FIXTURE, contextFor(EXPRESS_FIXTURE));
    expect(rules(result)).not.toContain("no-helmet");
    expect(rules(result)).not.toContain("no-rate-limiting");
    expect(result.issues).toContainEqual(expect.objectContaining({ rule: "open-cors", file: "src/app.js" }));
  });

  it("skips server-only checks (helmet, CORS, rate limiting, hashing) for plain Node projects", async () => {
    const result = await analyzeSecurity(NODE_FIXTURE, contextFor(NODE_FIXTURE, ["vendor"]));
    expect(result.summary).toBe("2/2 checks passed");
    expect(result.score).toBe(100);
  });

  it("honours ignore entries: the vendor/ secret is only reported when not ignored", async () => {
    const ignored = await analyzeSecurity(NODE_FIXTURE, contextFor(NODE_FIXTURE, ["vendor"]));
    expect(rules(ignored)).not.toContain("hardcoded-secret");

    const scanned = await analyzeSecurity(NODE_FIXTURE, contextFor(NODE_FIXTURE));
    expect(scanned.issues).toContainEqual(expect.objectContaining({ rule: "hardcoded-secret", file: "vendor/legacy-client.js", line: 4 }));
  });

  it("detects Stripe and GitHub token formats and skips placeholders", async () => {
    const dir = tempProject({
      "package.json": "{}",
      ".gitignore": ".env\n",
      "src/keys.ts": `export const stripe = "${fakeStripe}";\nexport const gh = "${fakeGithub}";\n`,
      "src/placeholders.ts": `export const a = { ${passwordKey}: "changeme" };\nexport const b = { ${passwordKey}: "<your-${passwordKey}>" };\nexport const c = { apiKey: "your_api_key_goes_here_123" };\n`,
    });
    const result = await analyzeSecurity(dir, contextFor(dir));
    const found = result.issues.filter((i) => i.rule === "hardcoded-secret").map((i) => `${i.file}:${i.line} ${i.message}`);
    expect(found).toEqual([
      "src/keys.ts:1 Possible Stripe Key found in source code",
      "src/keys.ts:2 Possible GitHub Token found in source code",
    ]);
  });

  it("scans every file (no 100-file cap)", async () => {
    const files: Record<string, string> = { "package.json": "{}", ".gitignore": ".env\n" };
    for (let i = 0; i < 120; i++) files[`src/f${String(i).padStart(3, "0")}.ts`] = "export {};\n";
    files["src/zzz.ts"] = `export const s = "${fakeStripe}";\n`;
    const dir = tempProject(files);
    const result = await analyzeSecurity(dir, contextFor(dir));
    expect(result.issues).toContainEqual(expect.objectContaining({ rule: "hardcoded-secret", file: "src/zzz.ts" }));
  });

  it("reports a .gitignore that does not cover .env", async () => {
    const dir = tempProject({ "package.json": "{}", ".gitignore": "node_modules\n" });
    const result = await analyzeSecurity(dir, contextFor(dir));
    expect(rules(result)).toContain("env-not-gitignored");
  });
});
