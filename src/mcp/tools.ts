import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { suggestRules } from "../reporters/rules.js";
import {
  getRule,
  RULES,
  type RuleDefinition,
  ruleDocsUrl,
} from "../rules/registry.js";
import { analyzesApi, scan } from "../scanner.js";
import type { DiagnosticIssue, ScanResult } from "../types.js";
import {
  type JsonSchemaObject,
  type McpTool,
  type ToolResult,
  toolError,
} from "./protocol.js";

type Severity = DiagnosticIssue["severity"];
type Check = "auth" | "validation";

const SEVERITIES: readonly Severity[] = ["critical", "warning", "info"];
const CHECKS = ["auth", "validation", "both"] as const;
/** Bounds tool output so a large project does not overflow the client's context. */
const MAX_RESULTS_LIMIT = 500;
const DEFAULT_MAX_FINDINGS = 50;
const DEFAULT_MAX_ROUTES = 100;

/** API Health rules about missing auth (CWE-306) or input validation (CWE-20). */
const ROUTE_CHECKS: ReadonlyMap<string, Check> = new Map(
  Object.entries(RULES as Record<string, RuleDefinition>).flatMap(
    ([id, rule]): [string, Check][] => {
      if (rule.analyzer !== "API Health") return [];
      if (rule.cwe?.includes("CWE-306")) return [[id, "auth"]];
      if (rule.cwe?.includes("CWE-20")) return [[id, "validation"]];
      return [];
    },
  ),
);

const SUPPORTED_FRAMEWORKS =
  "Next.js, SvelteKit, React Router/Remix, Express, Fastify, Hono, Elysia, NestJS, and tRPC";

/** A bad argument; reported to the model as a tool error it can correct. */
class ArgumentError extends Error {}

function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ArgumentError(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalChoice<T extends string>(
  args: Record<string, unknown>,
  name: string,
  choices: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const choice = choices.find((candidate) => candidate === value);
  if (!choice) {
    throw new ArgumentError(`${name} must be one of: ${choices.join(", ")}.`);
  }
  return choice;
}

function optionalLimit(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new ArgumentError(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}

function projectDirectory(
  baseDirectory: string,
  args: Record<string, unknown>,
): string {
  const directory = resolve(baseDirectory, optionalString(args, "path") ?? ".");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new ArgumentError(`Directory not found: ${directory}`);
  }
  return directory;
}

/** The structured result, repeated as JSON text for clients without structured output. */
function structured(output: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/** Runs the tool body, turning argument errors into tool errors. */
function guarded(
  body: (args: Record<string, unknown>) => Promise<ToolResult>,
): McpTool["call"] {
  return async (args) => {
    try {
      return await body(args);
    } catch (error) {
      if (error instanceof ArgumentError) return toolError(error.message);
      throw error;
    }
  };
}

/** Finding fields that are set, without undefined keys. */
function location(issue: DiagnosticIssue): Record<string, unknown> {
  return {
    ...(issue.file === undefined ? {} : { file: issue.file }),
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.fix === undefined ? {} : { fix: issue.fix }),
    ...(issue.confidence === undefined ? {} : { confidence: issue.confidence }),
  };
}

function isActive(issue: DiagnosticIssue): boolean {
  return issue.suppression === undefined && issue.baseline !== true;
}

const PATH_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the project directory. Pass it: the server's working directory may not be the project. A relative path resolves against that working directory, the default.",
};

const LIMIT_PROPERTY = (what: string, fallback: number, max: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `The most ${what} to return. Defaults to ${fallback}.`,
});

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    rule: { type: "string" },
    severity: { type: "string", enum: SEVERITIES },
    message: { type: "string" },
    file: { type: "string" },
    line: { type: "number" },
    fix: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["rule", "severity", "message"],
};

function findUnprotectedRoutes(baseDirectory: string): McpTool {
  const outputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      project: { type: "string" },
      directory: { type: "string" },
      framework: { type: "string" },
      supported: { type: "boolean" },
      summary: { type: "string" },
      routes: {
        type: "array",
        items: {
          ...FINDING_SCHEMA,
          properties: {
            check: { type: "string", enum: ["auth", "validation"] },
            ...FINDING_SCHEMA.properties,
          },
          required: ["check", ...FINDING_SCHEMA.required],
        },
      },
      suppressed: { type: "number" },
      omitted: { type: "number" },
    },
    required: [
      "project",
      "directory",
      "framework",
      "supported",
      "summary",
      "routes",
      "suppressed",
      "omitted",
    ],
  };

  return {
    definition: {
      name: "find_unprotected_routes",
      title: "Find unprotected API routes",
      description: `List the API routes, form actions, and procedures in a Node.js project that anyone can call: no recognizable auth check, or no input validation. Understands where auth runs in ${SUPPORTED_FRAMEWORKS} (middleware and its matcher, hooks, guards, route middleware, tRPC context). Runs offline. Static analysis: read the cited file before calling a route vulnerable.`,
      inputSchema: {
        type: "object",
        properties: {
          path: PATH_PROPERTY,
          check: {
            type: "string",
            enum: CHECKS,
            description:
              "auth: routes without an auth check; validation: routes without input validation; both (default).",
          },
          maxResults: LIMIT_PROPERTY(
            "routes",
            DEFAULT_MAX_ROUTES,
            MAX_RESULTS_LIMIT,
          ),
        },
        additionalProperties: false,
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    call: guarded(async (args) => {
      const directory = projectDirectory(baseDirectory, args);
      const check = optionalChoice(args, "check", CHECKS) ?? "both";
      const maxResults = optionalLimit(
        args,
        "maxResults",
        DEFAULT_MAX_ROUTES,
        MAX_RESULTS_LIMIT,
      );
      const config = loadConfig(directory);
      const result = await scan(
        directory,
        {
          ...config,
          analyzers: {
            api: true,
            security: false,
            dependencies: false,
            testing: false,
            structure: false,
          },
        },
        { interactive: false, audit: false, secretHistory: false },
      );
      const wanted = (issue: DiagnosticIssue) => {
        const kind = ROUTE_CHECKS.get(issue.rule);
        return kind !== undefined && (check === "both" || check === kind);
      };
      const api = result.analyzers.find(({ name }) => name === "API Health");
      const relevant = (api?.issues ?? []).filter(wanted);
      const routes = relevant.filter(isActive).map((issue) => ({
        check: ROUTE_CHECKS.get(issue.rule),
        rule: issue.rule,
        severity: issue.severity,
        message: issue.message,
        ...location(issue),
      }));
      const suppressed = relevant.length - routes.length;
      const shown = routes.slice(0, maxResults);
      return structured({
        project: result.project,
        directory,
        framework: result.stack.framework,
        supported: api !== undefined,
        summary: routeSummary(result, api !== undefined, routes, suppressed),
        routes: shown,
        suppressed,
        omitted: routes.length - shown.length,
      });
    }),
  };
}

function routeSummary(
  result: ScanResult,
  supported: boolean,
  routes: readonly { check?: Check }[],
  suppressed: number,
): string {
  const { framework, unsupportedServer } = result.stack;
  if (!supported) {
    if (analyzesApi(framework)) {
      return `No API routes were found in this ${framework} project.`;
    }
    const detected = unsupportedServer
      ? `${framework}, with ${unsupportedServer}, which CodeDiag does not analyze`
      : framework;
    return `CodeDiag found no supported API framework in this project (detected: ${detected}). It analyzes ${SUPPORTED_FRAMEWORKS}.`;
  }
  const auth = routes.filter(({ check }) => check === "auth").length;
  const validation = routes.length - auth;
  const parts = [
    routes.length === 0
      ? "No routes without a recognizable auth check or input validation."
      : `${auth} without a recognizable auth check, ${validation} without input validation.`,
  ];
  if (suppressed > 0) {
    parts.push(`${suppressed} more suppressed with codediag-ignore comments.`);
  }
  return parts.join(" ");
}

function scanProject(baseDirectory: string): McpTool {
  const outputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      project: { type: "string" },
      directory: { type: "string" },
      framework: { type: "string" },
      score: { type: "number" },
      grade: { type: "string" },
      summary: { type: "string" },
      analyzers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            score: { type: "number" },
            findings: { type: "number" },
          },
          required: ["name", "score", "findings"],
        },
      },
      findings: {
        type: "array",
        items: {
          ...FINDING_SCHEMA,
          properties: {
            analyzer: { type: "string" },
            ...FINDING_SCHEMA.properties,
          },
          required: ["analyzer", ...FINDING_SCHEMA.required],
        },
      },
      omitted: { type: "number" },
    },
    required: [
      "project",
      "directory",
      "framework",
      "score",
      "grade",
      "summary",
      "analyzers",
      "findings",
      "omitted",
    ],
  };

  return {
    definition: {
      name: "scan_project",
      title: "Scan project health",
      description:
        "Run a full CodeDiag scan of a Node.js project: a 0-100 health score with API health, security, dependency, test, and structure findings, each with a rule ID, file, line, and suggested fix. Security includes Supabase tables without row level security, from supabase/migrations. Most severe findings first. Offline unless audit is true.",
      inputSchema: {
        type: "object",
        properties: {
          path: PATH_PROPERTY,
          minSeverity: {
            type: "string",
            enum: SEVERITIES,
            description:
              "Leave out findings below this severity. Defaults to warning.",
          },
          maxFindings: LIMIT_PROPERTY(
            "findings",
            DEFAULT_MAX_FINDINGS,
            MAX_RESULTS_LIMIT,
          ),
          audit: {
            type: "boolean",
            description:
              "Also run the package manager's vulnerability audit, which needs network access. Defaults to false.",
          },
        },
        additionalProperties: false,
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    call: guarded(async (args) => {
      const directory = projectDirectory(baseDirectory, args);
      const minSeverity =
        optionalChoice(args, "minSeverity", SEVERITIES) ?? "warning";
      const maxFindings = optionalLimit(
        args,
        "maxFindings",
        DEFAULT_MAX_FINDINGS,
        MAX_RESULTS_LIMIT,
      );
      const audit = args.audit ?? false;
      if (typeof audit !== "boolean") {
        throw new ArgumentError("audit must be true or false.");
      }

      const result = await scan(directory, loadConfig(directory), {
        interactive: false,
        audit,
      });
      const floor = SEVERITIES.indexOf(minSeverity);
      const findings = result.analyzers
        .flatMap(({ name, issues }) =>
          issues.filter(isActive).map((issue) => ({ analyzer: name, issue })),
        )
        .filter(({ issue }) => SEVERITIES.indexOf(issue.severity) <= floor)
        .sort(
          (a, b) =>
            SEVERITIES.indexOf(a.issue.severity) -
            SEVERITIES.indexOf(b.issue.severity),
        );
      const shown = findings.slice(0, maxFindings);
      return structured({
        project: result.project,
        directory,
        framework: result.stack.framework,
        score: result.totalScore,
        grade: result.grade,
        summary: `${result.grade} (${result.totalScore}/100), ${findings.length} finding${findings.length === 1 ? "" : "s"} at ${minSeverity} or above.`,
        analyzers: result.analyzers.map(({ name, score, issues }) => ({
          name,
          score,
          findings: issues.filter(isActive).length,
        })),
        findings: shown.map(({ analyzer, issue }) => ({
          analyzer,
          rule: issue.rule,
          severity: issue.severity,
          message: issue.message,
          ...location(issue),
        })),
        omitted: findings.length - shown.length,
      });
    }),
  };
}

function explainRule(): McpTool {
  return {
    definition: {
      name: "explain_rule",
      title: "Explain a CodeDiag rule",
      description:
        "Explain a CodeDiag rule ID (the ID in a finding, such as missing-auth-check): what it detects, its severity, CWE and OWASP mapping, documentation link, and how to suppress a finding that is intentional.",
      inputSchema: {
        type: "object",
        properties: {
          ruleId: {
            type: "string",
            description: "The rule ID, for example missing-auth-check.",
          },
        },
        required: ["ruleId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          analyzer: { type: "string" },
          defaultSeverity: { type: "string", enum: SEVERITIES },
          description: { type: "string" },
          cwe: { type: "array", items: { type: "string" } },
          owasp: { type: "array", items: { type: "string" } },
          docs: { type: "string" },
          suppress: { type: "string" },
        },
        required: [
          "id",
          "title",
          "analyzer",
          "defaultSeverity",
          "description",
          "cwe",
          "owasp",
          "docs",
          "suppress",
        ],
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    call: guarded(async (args) => {
      const id = args.ruleId;
      if (typeof id !== "string" || id.length === 0) {
        throw new ArgumentError("ruleId must be a non-empty string.");
      }
      const rule = getRule(id);
      if (!rule) {
        const suggestions = suggestRules(id);
        throw new ArgumentError(
          `Unknown rule "${id}".${suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : ""}`,
        );
      }
      return structured({
        id,
        title: rule.title,
        analyzer: rule.analyzer,
        defaultSeverity: rule.defaultSeverity,
        description: rule.description,
        cwe: [...(rule.cwe ?? [])],
        owasp: [...(rule.owasp ?? [])],
        docs: ruleDocsUrl(id),
        suppress: `// codediag-ignore-next-line ${id} -- <why this is acceptable>`,
      });
    }),
  };
}

/** The tools the CodeDiag MCP server offers; relative paths resolve against baseDirectory. */
export function createCodediagTools(
  baseDirectory: string = process.cwd(),
): McpTool[] {
  return [
    findUnprotectedRoutes(baseDirectory),
    scanProject(baseDirectory),
    explainRule(),
  ];
}
