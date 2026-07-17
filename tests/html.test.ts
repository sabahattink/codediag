import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../src/reporters/html.js";
import type { ScanResult } from "../src/types.js";

function fixture(): ScanResult {
  return {
    project: 'api <core> & "edge"',
    stack: {
      framework: "nestjs",
      language: "typescript",
      orm: "prisma",
      hasDocker: true,
      hasEnvFile: true,
      hasPrisma: true,
      hasTests: true,
      packageManager: "pnpm",
    },
    analyzers: [
      {
        name: "Security",
        score: 70,
        summary: "2/3 checks passed",
        issues: [
          {
            severity: "critical",
            rule: "secret-leak",
            message: "Credential <exposed>",
            file: "src/config.ts",
            line: 12,
            fix: 'Move it to an environment variable & rotate "now"',
          },
          {
            severity: "info",
            rule: "review",
            message: "Review configuration",
          },
        ],
      },
    ],
    totalScore: 70,
    grade: "B",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("HTML reporter renders a complete interactive dashboard", () => {
  const html = renderHtml(fixture());

  assert.match(html, /^<!doctype html>/);
  assert.match(
    html,
    /<title>api &lt;core&gt; &amp; &quot;edge&quot; · CodeDiag report<\/title>/,
  );
  assert.match(html, /aria-label="Total score 70 out of 100, grade B"/);
  assert.match(html, /data-filter="critical"/);
  assert.match(html, /data-severity="critical"/);
  assert.match(html, /src\/config\.ts:12/);
  assert.match(
    html,
    /Move it to an environment variable &amp; rotate &quot;now&quot;/,
  );
  assert.match(html, /No source code was uploaded/);
  assert.match(html, /<\/html>$/);
});

test("HTML reporter escapes untrusted report content", () => {
  const html = renderHtml(fixture());

  assert.doesNotMatch(html, /<core>/);
  assert.doesNotMatch(html, /Credential <exposed>/);
  assert.match(html, /Credential &lt;exposed&gt;/);
});
