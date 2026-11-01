import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCodediagTools } from "../src/mcp/tools.js";

const UNGUARDED_POST = [
  "export async function POST(request) {",
  "  const body = await request.json();",
  "  return Response.json(body);",
  "}",
].join("\n");

function createProject(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-mcp-"));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "mcp-fixture",
      dependencies: { next: "^15.0.0" },
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
}

function tool(name: string, baseDirectory?: string) {
  const found = createCodediagTools(baseDirectory).find(
    (candidate) => candidate.definition.name === name,
  );
  assert.ok(found, `tool ${name} exists`);
  return found;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((block) => block.text).join("\n");
}

test("the server offers the three CodeDiag tools with object input schemas", () => {
  const tools = createCodediagTools();
  assert.deepEqual(
    tools.map((candidate) => candidate.definition.name),
    ["find_unprotected_routes", "scan_project", "explain_rule"],
  );
  for (const candidate of tools) {
    assert.equal(candidate.definition.inputSchema.type, "object");
    assert.ok(candidate.definition.description.length > 40);
    assert.equal(candidate.definition.annotations?.readOnlyHint, true);
  }
});

test("find_unprotected_routes lists routes without auth or validation", async () => {
  const directory = createProject({
    "app/api/items/route.js": UNGUARDED_POST,
  });
  try {
    const result = await tool("find_unprotected_routes", directory).call({});
    assert.equal(result.isError, undefined);
    const output = result.structuredContent as {
      directory: string;
      framework: string;
      supported: boolean;
      routes: { check: string; rule: string; file: string; message: string }[];
      suppressed: number;
      omitted: number;
    };
    // The scanned directory is echoed so an agent can spot the wrong one.
    assert.equal(output.directory, directory);
    assert.equal(output.omitted, 0);
    assert.equal(output.framework, "nextjs");
    assert.equal(output.supported, true);
    assert.deepEqual(
      output.routes.map(({ check, rule, file }) => ({ check, rule, file })),
      [
        {
          check: "auth",
          rule: "missing-auth-check",
          file: "app/api/items/route.js",
        },
        {
          check: "validation",
          rule: "missing-request-validation",
          file: "app/api/items/route.js",
        },
      ],
    );
    assert.equal(
      output.routes[0]?.message,
      "POST /api/items has no recognizable auth check",
    );
    assert.equal(output.suppressed, 0);
    // The text block carries the same data for clients without structured output.
    assert.deepEqual(JSON.parse(textOf(result)), output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("find_unprotected_routes narrows to one check and skips suppressed findings", async () => {
  const directory = createProject({
    "app/api/items/route.js": UNGUARDED_POST,
    "app/api/hooks/route.js": [
      "// codediag-ignore-next-line missing-auth-check -- signed webhook",
      UNGUARDED_POST,
    ].join("\n"),
  });
  try {
    const result = await tool("find_unprotected_routes", directory).call({
      path: ".",
      check: "auth",
    });
    const output = result.structuredContent as {
      routes: { check: string; file: string }[];
      suppressed: number;
    };
    assert.deepEqual(
      output.routes.map(({ check, file }) => ({ check, file })),
      [{ check: "auth", file: "app/api/items/route.js" }],
    );
    assert.equal(output.suppressed, 1);

    const limited = await tool("find_unprotected_routes", directory).call({
      maxResults: 1,
    });
    const page = limited.structuredContent as {
      routes: unknown[];
      omitted: number;
    };
    assert.equal(page.routes.length, 1);
    assert.equal(page.omitted, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("find_unprotected_routes says so when no supported framework is found", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codediag-mcp-"));
  writeFileSync(join(directory, "package.json"), '{"name":"plain"}');
  writeFileSync(join(directory, "index.js"), "console.log(1);\n");
  try {
    const result = await tool("find_unprotected_routes", directory).call({});
    const output = result.structuredContent as {
      supported: boolean;
      routes: unknown[];
      summary: string;
    };
    assert.equal(output.supported, false);
    assert.deepEqual(output.routes, []);
    assert.match(output.summary, /no supported API framework/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scan_project returns the score and the most severe findings first", async () => {
  const directory = createProject({
    "app/api/items/route.js": UNGUARDED_POST,
  });
  try {
    const result = await tool("scan_project", directory).call({
      maxFindings: 2,
    });
    const output = result.structuredContent as {
      score: number;
      grade: string;
      analyzers: { name: string; score: number; findings: number }[];
      findings: { severity: string; rule: string }[];
      omitted: number;
    };
    assert.ok(output.score >= 0 && output.score <= 100);
    assert.match(output.grade, /^(A\+|A|B\+|B|C|D|F)$/);
    assert.ok(output.analyzers.some(({ name }) => name === "API Health"));
    assert.equal(output.findings.length, 2);
    assert.ok(output.omitted > 0);
    const order = { critical: 0, warning: 1, info: 2 } as const;
    const ranks = output.findings.map(
      ({ severity }) => order[severity as keyof typeof order],
    );
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
    );
    assert.ok(output.findings.every(({ severity }) => severity !== "info"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explain_rule describes a rule and how to suppress it", async () => {
  const result = await tool("explain_rule").call({
    ruleId: "missing-auth-check",
  });
  const output = result.structuredContent as Record<string, unknown>;
  assert.equal(output.id, "missing-auth-check");
  assert.equal(output.analyzer, "API Health");
  assert.deepEqual(output.cwe, ["CWE-306"]);
  assert.match(String(output.docs), /#missing-auth-check$/);
  assert.equal(
    output.suppress,
    "// codediag-ignore-next-line missing-auth-check -- <why this is acceptable>",
  );
});

test("invalid arguments and unknown rules are tool errors", async () => {
  const unknownRule = await tool("explain_rule").call({
    ruleId: "missing-auth",
  });
  assert.equal(unknownRule.isError, true);
  assert.match(textOf(unknownRule), /Unknown rule "missing-auth"/);

  const missingRule = await tool("explain_rule").call({});
  assert.equal(missingRule.isError, true);
  assert.match(textOf(missingRule), /ruleId must be a non-empty string/);

  const badLimit = await tool("scan_project").call({ maxFindings: 0 });
  assert.equal(badLimit.isError, true);
  assert.match(
    textOf(badLimit),
    /maxFindings must be an integer from 1 to 500/,
  );

  const badCheck = await tool("find_unprotected_routes").call({
    check: "everything",
  });
  assert.equal(badCheck.isError, true);
  assert.match(
    textOf(badCheck),
    /check must be one of: auth, validation, both/,
  );

  const missingDirectory = await tool("scan_project").call({
    path: join(tmpdir(), "codediag-mcp-does-not-exist"),
  });
  assert.equal(missingDirectory.isError, true);
  assert.match(textOf(missingDirectory), /Directory not found/);
});
