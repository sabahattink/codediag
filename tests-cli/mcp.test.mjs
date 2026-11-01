import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repositoryRoot, "dist", "index.js");

async function createProject() {
  const directory = await mkdtemp(join(tmpdir(), "codediag-mcp-cli-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "mcp-cli", dependencies: { next: "^15.0.0" } }),
  );
  const route = join(directory, "app", "api", "items", "route.js");
  await mkdir(dirname(route), { recursive: true });
  await writeFile(
    route,
    [
      "export async function POST(request) {",
      "  const body = await request.json();",
      "  return Response.json(body);",
      "}",
    ].join("\n"),
  );
  return directory;
}

test("codediag mcp works with the official MCP SDK client", async () => {
  const project = await createProject();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, "mcp"],
    cwd: project,
    stderr: "pipe",
  });
  const client = new Client({ name: "codediag-cli-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { version } = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(client.getServerVersion(), {
      name: "codediag",
      title: "CodeDiag",
      version,
    });
    assert.match(client.getInstructions() ?? "", /find_unprotected_routes/);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["find_unprotected_routes", "scan_project", "explain_rule"],
    );

    // The client validates structuredContent against each tool's outputSchema.
    const routes = await client.callTool({
      name: "find_unprotected_routes",
      arguments: {},
    });
    assert.notEqual(routes.isError, true);
    assert.deepEqual(
      routes.structuredContent.routes.map(({ check, rule, file }) => ({
        check,
        rule,
        file,
      })),
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

    const scanned = await client.callTool({
      name: "scan_project",
      arguments: { maxFindings: 3 },
    });
    assert.notEqual(scanned.isError, true);
    assert.equal(scanned.structuredContent.findings.length, 3);

    const explained = await client.callTool({
      name: "explain_rule",
      arguments: { ruleId: "missing-auth-check" },
    });
    assert.equal(explained.structuredContent.analyzer, "API Health");

    await assert.rejects(
      client.callTool({ name: "no_such_tool", arguments: {} }),
      /Unknown tool: no_such_tool/,
    );
  } finally {
    await client.close();
    await rm(project, { recursive: true, force: true });
  }
});
