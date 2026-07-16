import assert from "node:assert/strict";
import test from "node:test";
import { renderSvg } from "../src/reporters/svg.js";
import type { ScanResult } from "../src/types.js";

function result(score: number, grade: string, project = "fixture"): ScanResult {
  return {
    project,
    stack: {
      framework: "generic",
      language: "typescript",
      orm: null,
      hasDocker: false,
      hasEnvFile: false,
      hasPrisma: false,
      hasTests: false,
      packageManager: "npm",
    },
    analyzers: [],
    totalScore: score,
    grade,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("SVG reporter renders an accessible score badge", () => {
  const svg = renderSvg(result(87, "B+"));

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="codediag: 87\/100 B\+"/);
  assert.match(svg, /<title>codediag: fixture 87\/100 \(B\+\)<\/title>/);
  assert.match(svg, /fill="#3fb950"/);
  assert.match(svg, /<\/svg>$/);
});

test("SVG reporter escapes project names and changes color by score", () => {
  const svg = renderSvg(result(42, "F", 'api <core> & "edge"'));

  assert.match(
    svg,
    /<title>codediag: api &lt;core&gt; &amp; &quot;edge&quot; 42\/100 \(F\)<\/title>/,
  );
  assert.match(svg, /fill="#d1242f"/);
  assert.doesNotMatch(svg, /api <core>/);
});
