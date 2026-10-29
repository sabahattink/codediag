import { describe, it, expect } from "vitest";
import { stripVTControlCharacters } from "util";
import { renderJson } from "../src/reporters/json.js";
import { renderMarkdown } from "../src/reporters/markdown.js";
import { renderTerminal } from "../src/reporters/terminal.js";
import type { DiagnosticIssue, ScanResult } from "../src/types.js";

function result(issues: DiagnosticIssue[] = []): ScanResult {
  return {
    project: "demo|app",
    stack: { framework: "nestjs", language: "typescript", orm: "prisma", hasDocker: false, hasEnvFile: false, hasPrisma: true, hasTests: true, packageManager: "npm" },
    analyzers: [
      { name: "API Health", score: 85, issues: issues.filter((i) => i.rule.startsWith("api")), summary: "3 endpoints | 1 controller" },
      { name: "Security", score: 65, issues: issues.filter((i) => !i.rule.startsWith("api")), summary: "4/6 checks passed" },
      { name: "Testing", score: 20, issues: [], summary: "0 test files" },
    ],
    totalScore: 59,
    grade: "F",
    timestamp: "2026-03-04T23:59:59.000Z",
  };
}

const sampleIssues: DiagnosticIssue[] = [
  { severity: "info", rule: "api-swagger", message: "GET /users has no Swagger documentation", file: "src/users.controller.ts", line: 12 },
  { severity: "warning", rule: "api-guard", message: "POST /users has no auth guard", file: "src/users.controller.ts", line: 20 },
  { severity: "critical", rule: "hardcoded-secret", message: "Possible API Key | found", file: "src/config.ts", line: 5, fix: "Use env vars" },
];

const plain = (text: string): string => stripVTControlCharacters(text);

describe("renderJson", () => {
  it("round-trips the scan result", () => {
    const r = result(sampleIssues);
    expect(JSON.parse(renderJson(r))).toEqual(r);
  });
});

describe("renderMarkdown", () => {
  it("renders a score table with icons, summaries and the total", () => {
    const md = renderMarkdown(result());
    expect(md.split("\n")[0]).toBe("## codediag — Diagnostic Report");
    expect(md).toContain("**Project:** demo\\|app · **Stack:** nestjs + typescript + prisma · **Score:** 59/100 (F)");
    expect(md).toContain("| ✅ API Health | 85/100 | 3 endpoints \\| 1 controller |");
    expect(md).toContain("| ⚠️ Security | 65/100 | 4/6 checks passed |");
    expect(md).toContain("| ❌ Testing | 20/100 | 0 test files |");
    expect(md).toContain("| **Total** | **59/100 (F)** | |");
  });

  it("uses the scan timestamp (not the local clock) for the date", () => {
    expect(renderMarkdown(result())).toMatch(/on 2026-03-04$/);
  });

  it("omits the issues section when there are no issues", () => {
    expect(renderMarkdown(result())).not.toContain("### Issues");
  });

  it("lists critical and warning issues by severity with file:line, hiding info by default", () => {
    const md = renderMarkdown(result(sampleIssues));
    expect(md).toContain("### Issues (1 critical · 1 warnings · 1 info)");
    const items = md.split("\n").filter((l) => l.startsWith("- "));
    expect(items).toEqual([
      "- ❌ Possible API Key \\| found — `src/config.ts:5`",
      "- ⚠️ POST /users has no auth guard — `src/users.controller.ts:20`",
    ]);
    expect(md).toContain("_1 info issues hidden (use --verbose)._");
  });

  it("includes info issues with --verbose", () => {
    const md = renderMarkdown(result(sampleIssues), { verbose: true });
    expect(md).toContain("GET /users has no Swagger documentation");
    expect(md).not.toContain("hidden");
  });
});

describe("renderTerminal", () => {
  it("prints only the score line in quiet mode", () => {
    const lines = plain(renderTerminal(result(sampleIssues), { quiet: true })).split("\n").filter((l) => l.trim());
    expect(lines).toEqual(["  codediag 59/100 F"]);
  });

  it("shows critical/warning issues with file:line and hides info without --verbose", () => {
    const out = plain(renderTerminal(result(sampleIssues)));
    expect(out).toContain("Score:    F (59/100)");
    expect(out).toContain("1 critical · 1 warnings · 1 info");
    expect(out).toContain("src/config.ts:5");
    expect(out).toContain("→ Use env vars");
    expect(out).not.toContain("Swagger");
    expect(out).toContain("1 info issues hidden (use --verbose)");
  });

  it("shows every issue with --verbose", () => {
    const out = plain(renderTerminal(result(sampleIssues), { verbose: true }));
    expect(out).toContain("GET /users has no Swagger documentation");
    expect(out).not.toContain("hidden");
  });

  it("caps the default list at 10 issues and says how many more there are", () => {
    const many: DiagnosticIssue[] = Array.from({ length: 13 }, (_, i) => ({ severity: "warning", rule: "w", message: `warning ${i}` }));
    const out = plain(renderTerminal(result(many)));
    expect(out).toContain("warning 9");
    expect(out).not.toContain("warning 10");
    expect(out).toContain("... and 3 more issues (use --verbose)");
  });

  it("celebrates a clean result", () => {
    expect(plain(renderTerminal(result()))).toContain("No issues found. Ship it!");
  });
});
