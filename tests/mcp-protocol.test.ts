import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpHandler,
  type McpTool,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/mcp/protocol.js";

const INFO = { name: "codediag", title: "CodeDiag", version: "9.9.9" };

const echo: McpTool = {
  definition: {
    name: "echo",
    title: "Echo",
    description: "Returns its text argument.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
  },
  async call(args) {
    return { content: [{ type: "text", text: String(args.text) }] };
  },
};

const broken: McpTool = {
  definition: {
    name: "broken",
    title: "Broken",
    description: "Always throws.",
    inputSchema: { type: "object", properties: {} },
  },
  async call() {
    throw new Error("disk on fire");
  },
};

const handle = createMcpHandler(INFO, [echo, broken]);

test("initialize echoes a supported protocol version and advertises tools", async () => {
  const response = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: INFO,
    },
  });
});

test("initialize answers an unknown protocol version with the latest supported one", async () => {
  const response = await handle({
    jsonrpc: "2.0",
    id: "a",
    method: "initialize",
    params: { protocolVersion: "1999-01-01", capabilities: {} },
  });
  assert.ok(response && !Array.isArray(response));
  assert.deepEqual(
    (response.result as { protocolVersion: string }).protocolVersion,
    SUPPORTED_PROTOCOL_VERSIONS[0],
  );
});

test("initialize includes server instructions when they are set", async () => {
  const withInstructions = createMcpHandler(
    { ...INFO, instructions: "Read the cited file first." },
    [],
  );
  const response = await withInstructions({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  });
  assert.ok(response && !Array.isArray(response));
  const result = response.result as { instructions?: string };
  assert.equal(result.instructions, "Read the cited file first.");
});

test("notifications and client responses get no reply", async () => {
  assert.equal(
    await handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
  assert.equal(
    await handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 3 },
    }),
    null,
  );
  assert.equal(await handle({ jsonrpc: "2.0", id: 7, result: {} }), null);
});

test("ping answers with an empty result", async () => {
  assert.deepEqual(await handle({ jsonrpc: "2.0", id: 2, method: "ping" }), {
    jsonrpc: "2.0",
    id: 2,
    result: {},
  });
});

test("unknown methods and malformed requests are JSON-RPC errors", async () => {
  assert.deepEqual(
    await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
    {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found: resources/list" },
    },
  );
  assert.deepEqual(await handle({ id: 4, method: "ping" }), {
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32600, message: "Invalid Request" },
  });
  assert.deepEqual(await handle("ping"), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
  assert.deepEqual(await handle({ jsonrpc: "2.0", id: null, method: "ping" }), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
});

test("a batch is answered with one response per request", async () => {
  const response = await handle([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "nope" },
  ]);
  assert.deepEqual(response, [
    { jsonrpc: "2.0", id: 1, result: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Method not found: nope" },
    },
  ]);
  assert.deepEqual(await handle([]), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
  assert.equal(
    await handle([{ jsonrpc: "2.0", method: "notifications/initialized" }]),
    null,
  );
});

test("tools/list returns every tool definition", async () => {
  const response = await handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
  });
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 5,
    result: { tools: [echo.definition, broken.definition] },
  });
});

test("tools/call runs the tool with its arguments", async () => {
  const response = await handle({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hi" } },
  });
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 6,
    result: { content: [{ type: "text", text: "hi" }] },
  });
});

test("tools/call reports an unknown tool as invalid params", async () => {
  assert.deepEqual(
    await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    }),
    {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "Unknown tool: missing" },
    },
  );
  assert.deepEqual(
    await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }),
    {
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32602, message: "tools/call needs a tool name" },
    },
  );
});

test("tool failures and bad arguments come back as tool errors the model can read", async () => {
  assert.deepEqual(
    await handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "broken", arguments: {} },
    }),
    {
      jsonrpc: "2.0",
      id: 9,
      result: {
        content: [{ type: "text", text: "broken failed: disk on fire" }],
        isError: true,
      },
    },
  );
  assert.deepEqual(
    await handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "echo", arguments: ["not", "an", "object"] },
    }),
    {
      jsonrpc: "2.0",
      id: 10,
      result: {
        content: [{ type: "text", text: "Tool arguments must be an object." }],
        isError: true,
      },
    },
  );
});
