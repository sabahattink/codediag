import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { getPackageVersion } from "../version.js";
import {
  createMcpHandler,
  type JsonRpcResponse,
  parseErrorResponse,
} from "./protocol.js";
import { createCodediagTools } from "./tools.js";

const INSTRUCTIONS = [
  "CodeDiag statically analyzes Node.js projects.",
  "Use find_unprotected_routes when asked which API routes, form actions, or procedures lack auth or input validation;",
  "scan_project for an overall health or security review; explain_rule to explain the rule ID in a finding.",
  "Pass the project's absolute path as `path`: this server's working directory may not be the project.",
  "Findings are heuristic: open the cited file and check where auth actually runs before telling the user a route is vulnerable.",
  "Routes that are public on purpose, such as sign-in, health checks, or signed webhooks, can be suppressed with a",
  "`// codediag-ignore-next-line <rule> -- <reason>` comment.",
].join(" ");

function write(
  output: Writable,
  response: JsonRpcResponse | JsonRpcResponse[],
): void {
  // JSON.stringify escapes newlines, so each message stays on one line.
  output.write(`${JSON.stringify(response)}\n`);
}

/**
 * Serves MCP over stdio: one JSON-RPC message per line in, one per line out.
 * Requests are handled one at a time, in order. Resolves when input ends.
 * Nothing else may write to stdout while this runs.
 */
export async function runMcpServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const handle = createMcpHandler(
    {
      name: "codediag",
      title: "CodeDiag",
      version: getPackageVersion(),
      instructions: INSTRUCTIONS,
    },
    createCodediagTools(),
  );

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(output, parseErrorResponse());
      continue;
    }
    const response = await handle(message);
    if (response) write(output, response);
  }
}
