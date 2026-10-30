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
  assert.match(
    html,
    /<time datetime="2026-01-01T00:00:00.000Z">2026-01-01 00:00 UTC<\/time>/,
  );
  assert.match(html, /<\/html>$/);
});

test("HTML reporter shows changes since a previous scan and new findings", () => {
  const result = fixture();
  result.analyzers[0].issues[0].isNew = true;
  result.comparison = {
    previousTimestamp: "2025-12-24T00:00:00.000Z",
    previousScore: 64,
    previousGrade: "D",
    scoreDelta: 6,
    analyzers: [{ name: "Security", previous: 64, current: 70, delta: 6 }],
    newFindings: 1,
    fixedFindings: 1,
    fixed: [
      {
        analyzer: "Security",
        rule: "open-cors",
        severity: "warning",
        message: "CORS <open>",
        file: "src/main.ts",
        line: 4,
      },
    ],
  };

  const html = renderHtml(result);

  assert.match(html, /<h2 id="changes-title">Changes<\/h2>/);
  assert.match(html, /<span class="delta up"[^>]*>\+6<\/span>/);
  assert.match(html, /data-filter="new" aria-pressed="false">New 1</);
  assert.match(html, /data-new="true"/);
  assert.match(html, /<span class="tag new">new<\/span>/);
  assert.match(html, /CORS &lt;open&gt;/);
  assert.match(html, /src\/main\.ts:4/);
  assert.doesNotMatch(renderHtml(fixture()), /data-filter="new"/);
});

test("HTML reporter explains a scan limited to changed files", () => {
  const result = fixture();
  result.scope = { changedSince: "origin/main", files: 3, excludedFindings: 9 };

  assert.match(
    renderHtml(result),
    /3 files changed since <code>origin\/main<\/code> are reported and scored; 9 findings elsewhere were left out/,
  );
});

test("HTML reporter escapes untrusted report content", () => {
  const html = renderHtml(fixture());

  assert.doesNotMatch(html, /<core>/);
  assert.doesNotMatch(html, /Credential <exposed>/);
  assert.match(html, /Credential &lt;exposed&gt;/);
});

test("HTML reporter explains lost points and root-caused findings", () => {
  const result = fixture();
  result.analyzers[0].scoreBreakdown = [
    { rule: "secret-leak", count: 1, penalty: 25 },
    { rule: "review", count: 3, penalty: 3.5 },
  ];
  result.analyzers[0].issues[1].causedBy = "secret-leak";

  const html = renderHtml(result);

  assert.match(html, /<ul class="breakdown" aria-label="Points lost by rule">/);
  assert.match(
    html,
    /<li><code>secret-leak<\/code><span>×1<\/span><strong>-25<\/strong><\/li>/,
  );
  assert.match(html, /<strong>-3\.5<\/strong>/);
  assert.match(html, /Security \/ review · caused by secret-leak/);
  assert.doesNotMatch(renderHtml(fixture()), /class="breakdown"/);
});

test("HTML reporter charts the score history with readable points and a table", () => {
  const result = fixture();
  result.history = [
    {
      timestamp: "2025-12-01T00:00:00.000Z",
      totalScore: 52,
      grade: "F",
      analyzers: { Security: 40 },
    },
    {
      timestamp: "2025-12-15T00:00:00.000Z",
      totalScore: 61,
      grade: "D",
      analyzers: { Security: 55 },
    },
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      totalScore: 70,
      grade: "B",
      analyzers: { Security: 70 },
    },
  ];

  const html = renderHtml(result);

  assert.match(html, /<h2 id="history-title">Score history<\/h2>/);
  assert.match(html, /52 → 70 over 3 scans since/);
  assert.match(
    html,
    /<polyline class="trend" points="44\.0,[\d.]+ 360\.0,[\d.]+ 676\.0,[\d.]+"\/>/,
  );
  assert.equal(html.match(/class="point" tabindex="0"/g)?.length, 3);
  assert.match(html, /aria-label="2025-12-15: 61 \(D\)"/);
  assert.match(html, /Show the 3 scans as a table/);
  assert.match(html, /<th scope="col">Security<\/th>/);

  result.history = result.history.slice(0, 1);
  assert.match(renderHtml(result), /First recorded scan/);
  assert.doesNotMatch(renderHtml(fixture()), /history-title/);
});

test("HTML reporter marks packages below their package threshold", () => {
  const html = renderHtml({
    ...fixture(),
    workspace: {
      tool: "npm",
      packages: [
        {
          path: "packages/api",
          framework: "fastify",
          totalScore: 52,
          grade: "F",
          findings: 3,
          threshold: 70,
        },
        {
          path: "packages/web",
          framework: "nextjs",
          totalScore: 88,
          grade: "B+",
          findings: 1,
          threshold: 70,
        },
      ],
    },
  });

  assert.match(
    html,
    /3 findings · <strong class="gate">below its threshold of 70<\/strong>/,
  );
  assert.match(html, /1 finding · threshold 70 met/);
});
