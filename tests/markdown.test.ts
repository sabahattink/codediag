import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/reporters/markdown.js";
import type { ScanResult } from "../src/types.js";

const result: ScanResult = {
  project: "fixture",
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
  analyzers: [{ name: "Security", score: 92, summary: "", issues: [] }],
  totalScore: 92,
  grade: "A",
  timestamp: "2026-01-02T00:00:00.000Z",
};

test("markdown lists score changes per analyzer and fixed findings", () => {
  const markdown = renderMarkdown({
    ...result,
    comparison: {
      previousTimestamp: "2026-01-01T00:00:00.000Z",
      previousScore: 80,
      previousGrade: "B",
      scoreDelta: 12,
      analyzers: [
        { name: "Security", previous: 80, current: 92, delta: 12 },
        { name: "Testing", previous: 70, current: null, delta: null },
      ],
      newFindings: 0,
      fixedFindings: 1,
      fixed: [
        {
          analyzer: "Security",
          rule: "open-cors",
          severity: "warning",
          message: "CORS | open",
          file: "src/main.ts",
          line: 7,
        },
      ],
    },
  });

  assert.match(markdown, /### Changes since 2026-01-01/);
  assert.match(markdown, /Score 80 → 92 \(\*\*\+12\*\*\) · 0 new · 1 fixed/);
  assert.match(markdown, /\| Security \| 80 \| 92 \| \+12 \|/);
  assert.match(markdown, /\| Testing \| 70 \| — \| — \|/);
  assert.match(
    markdown,
    /- ✅ CORS \\| open `open-cors` \(`src\/main\.ts:7`\)/,
  );
});

test("markdown notes a scan scoped to changed files", () => {
  assert.match(
    renderMarkdown({
      ...result,
      scope: { changedSince: "main", files: 1, excludedFindings: 4 },
    }),
    /> Scoped to 1 file changed since `main`; 4 findings elsewhere were not scored\./,
  );
});

test("markdown marks workspace packages below their package threshold", () => {
  const markdown = renderMarkdown({
    ...result,
    workspace: {
      tool: "pnpm",
      packages: [
        {
          path: "apps/api",
          framework: "express",
          totalScore: 58,
          grade: "F",
          findings: 4,
          threshold: 60,
        },
        {
          path: "apps/web",
          framework: "nextjs",
          totalScore: 90,
          grade: "A",
          findings: 0,
          threshold: 60,
        },
      ],
    },
  });

  assert.match(
    markdown,
    /\| `apps\/api` \| express \| 58 \(F\) ❌ below 60 \| 4 \|/,
  );
  assert.match(markdown, /\| `apps\/web` \| nextjs \| 90 \(A\) \| 0 \|/);
});
