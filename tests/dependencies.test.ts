import assert from "node:assert/strict";
import test from "node:test";
import { parseAuditSummary } from "../src/analyzers/dependencies.js";

test("parses vulnerability counts from a non-zero npm audit result", () => {
  const summary = parseAuditSummary(
    JSON.stringify({
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 1,
          moderate: 2,
          high: 3,
          critical: 4,
          total: 10,
        },
      },
    }),
  );

  assert.deepEqual(summary, {
    critical: 4,
    high: 3,
    moderate: 2,
    low: 1,
  });
});

test("missing vulnerability metadata is treated as zero", () => {
  assert.deepEqual(parseAuditSummary("{}"), {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
  });
});
