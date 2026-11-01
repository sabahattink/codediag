/**
 * The part of the Model Context Protocol that a tools-only server needs:
 * JSON-RPC 2.0 framing, the initialize handshake, ping, tools/list, and
 * tools/call. Transport-agnostic; the stdio server feeds it parsed lines.
 *
 * Hand-written rather than built on @modelcontextprotocol/sdk, whose server
 * pulls Express, Hono, and an OAuth stack into every CLI install for
 * transports CodeDiag does not offer. tests-cli/mcp.test.mjs checks this
 * server against the SDK's own client.
 */

/** Newest first; an unknown requested version is answered with the first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  /** Matches the tool's outputSchema; content carries the same data as JSON. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpTool {
  definition: ToolDefinition;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  /** Sent in the initialize result as guidance for the model. */
  instructions?: string;
}

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type McpHandler = (
  message: unknown,
) => Promise<JsonRpcResponse | JsonRpcResponse[] | null>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The reply to a line that is not valid JSON. */
export function parseErrorResponse(): JsonRpcResponse {
  return errorResponse(null, PARSE_ERROR, "Parse error");
}

/** A failure the model should see and can react to, not a protocol error. */
export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMcpHandler(
  info: ServerInfo,
  tools: readonly McpTool[],
): McpHandler {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  function initialize(params: Record<string, unknown>): unknown {
    const requested = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(
      (version) => version === requested,
    );
    const { instructions, ...serverInfo } = info;
    return {
      protocolVersion: protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      ...(instructions ? { instructions } : {}),
    };
  }

  async function callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    if (typeof params.name !== "string") {
      return errorResponse(id, INVALID_PARAMS, "tools/call needs a tool name");
    }
    const tool = byName.get(params.name);
    if (!tool) {
      return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
    }
    const args = params.arguments ?? {};
    if (!isRecord(args)) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolError("Tool arguments must be an object."),
      };
    }
    try {
      return { jsonrpc: "2.0", id, result: await tool.call(args) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolError(`${params.name} failed: ${errorMessage(error)}`),
      };
    }
  }

  async function handleOne(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRecord(message)) {
      return errorResponse(null, INVALID_REQUEST, "Invalid Request");
    }
    const hasId = "id" in message;
    // A response to a request this server never sends; nothing to answer.
    if (typeof message.method !== "string" && hasId && !("method" in message)) {
      return null;
    }
    if (
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (hasId && !isId(message.id))
    ) {
      return errorResponse(
        isId(message.id) ? message.id : null,
        INVALID_REQUEST,
        "Invalid Request",
      );
    }
    // Notifications (initialized, cancelled, ...) need no reply.
    if (!hasId || !isId(message.id)) return null;

    const id = message.id;
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: initialize(params) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: tools.map((tool) => tool.definition) },
        };
      case "tools/call":
        return callTool(id, params);
      default:
        return errorResponse(
          id,
          METHOD_NOT_FOUND,
          `Method not found: ${message.method}`,
        );
    }
  }

  return async (message) => {
    if (!Array.isArray(message)) return handleOne(message);
    if (message.length === 0) {
      return errorResponse(null, INVALID_REQUEST, "Invalid Request");
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of message) {
      const response = await handleOne(item);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? responses : null;
  };
}
