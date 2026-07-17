import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { ScanResult } from "../src/types.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../schema/scan-result.schema.json", import.meta.url),
    "utf-8",
  ),
);
const validate: ValidateFunction<ScanResult> = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(schema);

function validResult(): ScanResult {
  return {
    project: "example-api",
    stack: {
      framework: "express",
      language: "typescript",
      orm: "prisma",
      hasDocker: true,
      hasEnvFile: true,
      hasPrisma: true,
      hasTests: true,
      packageManager: "npm",
    },
    analyzers: [
      {
        name: "API Health",
        score: 84,
        issues: [
          {
            severity: "warning",
            rule: "missing-health-endpoint",
            message: "No health endpoint detected",
            file: "src/app.ts",
            line: 12,
            fix: "Add a health endpoint",
          },
        ],
        summary: "4 endpoints",
      },
    ],
    totalScore: 84,
    grade: "B+",
    timestamp: "2026-07-17T10:20:30.000Z",
  };
}

test("JSON schema accepts the complete ScanResult contract", () => {
  const result = validResult();

  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("JSON schema accepts optional issue fields being omitted", () => {
  const result = validResult();
  result.analyzers[0].issues = [
    {
      severity: "info",
      rule: "example",
      message: "Example issue",
    },
  ];

  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("JSON schema rejects out-of-range scores and incomplete stacks", () => {
  const invalid = validResult() as unknown as Record<string, unknown>;
  invalid.totalScore = 101;
  delete (invalid.stack as Record<string, unknown>).packageManager;

  assert.equal(validate(invalid), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "maximum"));
  assert.ok(validate.errors?.some((error) => error.keyword === "required"));
});

test("JSON schema rejects unknown fields", () => {
  const invalid = {
    ...validResult(),
    undocumented: true,
  };

  assert.equal(validate(invalid), false);
  assert.ok(
    validate.errors?.some((error) => error.keyword === "additionalProperties"),
  );
});
