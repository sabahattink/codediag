import { Node, type SourceFile } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import { moduleIndex, runtimeSources } from "./fastify-plugins.js";
import { middlewareFile, middlewareRejects } from "./next-middleware.js";
import { importsTrpcAdapter } from "./trpc-syntax.js";

const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const BODY_METHODS = new Set(["PATCH", "POST", "PUT"]);
const AUTH_MARKERS =
  /getServerSession|auth\s*\(|currentUser|clerk|withAuth|requireAuth|authorize|authorization|bearer|jwt|session/i;
const VALIDATION_MARKERS =
  /safeParse|parseAsync|schema|validate|validation|zod|joi|yup|ajv/i;

interface NextEndpoint {
  method: string;
  path: string;
  file: string;
  line?: number;
  source: string;
}

function routeSegments(filePath: string, directory: "app" | "pages"): string[] {
  const parts = filePath.split(/[\\/]/);
  const directoryIndex = parts.lastIndexOf(directory);
  if (directoryIndex === -1) return [];

  const segments = parts.slice(directoryIndex + 1);
  segments.pop();

  return segments
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[\.\.\.(.+)\]$/, ":$1*"))
    .map((segment) => segment.replace(/^\[\[(?:\.\.\.)(.+)\]\]$/, ":$1*"))
    .map((segment) => segment.replace(/^\[(.+)\]$/, ":$1"));
}

function appRoutePath(filePath: string): string {
  const segments = routeSegments(filePath, "app");
  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

function pagesRoutePath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const pagesIndex = parts.lastIndexOf("pages");
  if (pagesIndex === -1) return "/";

  const segments = parts.slice(pagesIndex + 1);
  const filename = segments.pop()?.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
  if (filename && filename !== "index") segments.push(filename);

  return `/${segments
    .map((segment) => segment.replace(/^\[\.\.\.(.+)\]$/, ":$1*"))
    .map((segment) => segment.replace(/^\[(.+)\]$/, ":$1"))
    .join("/")}`.replace(/\/+/g, "/");
}

function appRouterEndpoints(
  sourceFile: SourceFile,
  file: string,
): NextEndpoint[] {
  const endpoints: NextEndpoint[] = [];
  const path = appRoutePath(sourceFile.getFilePath());

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName()?.toUpperCase();
    if (!declaration.isExported() || !name || !HTTP_METHODS.has(name)) continue;

    endpoints.push({
      method: name,
      path,
      file,
      line: declaration.getStartLineNumber(),
      source: declaration.getText(),
    });
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;

    for (const declaration of statement.getDeclarations()) {
      const name = declaration.getName().toUpperCase();
      if (!HTTP_METHODS.has(name)) continue;

      endpoints.push({
        method: name,
        path,
        file,
        line: declaration.getStartLineNumber(),
        source: declaration.getText(),
      });
    }
  }

  return endpoints;
}

function pagesRouterEndpoints(
  sourceFile: SourceFile,
  file: string,
): NextEndpoint[] {
  const methods = new Set<string>();

  for (const literal of sourceFile
    .getDescendants()
    .filter(Node.isStringLiteral)) {
    const value = literal.getLiteralText().toUpperCase();
    if (HTTP_METHODS.has(value)) methods.add(value);
  }

  if (methods.size === 0) methods.add("ALL");

  return [...methods].map((method) => ({
    method,
    path: pagesRoutePath(sourceFile.getFilePath()),
    file,
    source: sourceFile.getFullText(),
  }));
}

/**
 * Whether the project's middleware turns anonymous requests to a route path
 * away; dynamic segments are matched with a sample value. The project index
 * is built only when there is a middleware file.
 */
function middlewareGuard(context: ScanContext): (path: string) => boolean {
  const present = context.matchFiles([
    "{middleware,proxy}.{ts,js,mjs}",
    "src/{middleware,proxy}.{ts,js,mjs}",
  ]);
  if (present.length === 0) return () => false;
  const index = moduleIndex(context, runtimeSources(context));
  const middleware = middlewareFile(index);
  if (!middleware) return () => false;
  const verdicts = new Map<string, boolean>();
  return (path) => {
    const sample = path.replace(/:\w+\*?/g, "sample");
    let rejects = verdicts.get(sample);
    if (rejects === undefined) {
      rejects = middlewareRejects(index, middleware.sourceFile, sample);
      verdicts.set(sample, rejects);
    }
    return rejects;
  };
}

function hasMarker(source: string, marker: RegExp): boolean {
  marker.lastIndex = 0;
  return marker.test(source);
}

export async function analyzeNextjsApi(
  context: ScanContext,
): Promise<AnalyzerResult | null> {
  const routeFiles = context
    .matchFiles(
      [
        "{app,src/app}/**/route.{ts,tsx,js,mjs,cjs}",
        "{pages,src/pages}/api/**/*.{ts,tsx,js,mjs,cjs}",
      ],
      {
        exclude: [
          "**/*.test.{ts,tsx,js,mjs,cjs}",
          "**/*.spec.{ts,tsx,js,mjs,cjs}",
        ],
      },
    )
    // A tRPC handler's endpoints are its procedures, checked by trpc-api.ts.
    .filter((file) => {
      const sourceFile = context.getSourceFile(file);
      return !sourceFile || !importsTrpcAdapter(sourceFile);
    });

  if (routeFiles.length === 0) return null;

  const endpoints: NextEndpoint[] = [];

  for (const routeFile of routeFiles) {
    const sourceFile = context.getSourceFile(routeFile);
    if (!sourceFile) continue;

    if (/(?:^|\/)pages\/api\//.test(routeFile)) {
      endpoints.push(...pagesRouterEndpoints(sourceFile, routeFile));
    } else {
      endpoints.push(...appRouterEndpoints(sourceFile, routeFile));
    }
  }

  if (endpoints.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-nextjs-handlers"),
          message: "Next.js API route files contain no detectable handlers",
        },
      ],
      summary: `${routeFiles.length} API route files, 0 handlers`,
    };
  }

  const guarded = middlewareGuard(context);
  const authenticated = (endpoint: NextEndpoint) =>
    guarded(endpoint.path) || hasMarker(endpoint.source, AUTH_MARKERS);

  const issues: DiagnosticIssue[] = [];
  const mutatingEndpoints = endpoints.filter((endpoint) =>
    MUTATING_METHODS.has(endpoint.method),
  );
  const bodyEndpoints = endpoints.filter((endpoint) =>
    BODY_METHODS.has(endpoint.method),
  );

  for (const endpoint of mutatingEndpoints) {
    if (!authenticated(endpoint)) {
      issues.push({
        ...fromRule("missing-auth-check"),
        message: `${endpoint.method} ${endpoint.path} has no recognizable auth check`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Require authentication in the handler or matching middleware",
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!hasMarker(endpoint.source, VALIDATION_MARKERS)) {
      issues.push({
        ...fromRule("missing-request-validation"),
        message: `${endpoint.method} ${endpoint.path} has no recognizable request validation`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Validate request input with an explicit schema",
      });
    }
  }

  const broadPagesHandlers = endpoints.filter(
    (endpoint) => endpoint.method === "ALL",
  );
  for (const endpoint of broadPagesHandlers) {
    issues.push({
      ...fromRule("implicit-pages-methods"),
      message: `${endpoint.path} does not expose explicit HTTP method branches`,
      file: endpoint.file,
      fix: "Reject unsupported request methods explicitly",
    });
  }

  const hasHealthEndpoint = endpoints.some((endpoint) =>
    /(?:^|\/)(?:health|healthz|live|ready|readiness|liveness)(?:\/|$)/i.test(
      endpoint.path,
    ),
  );
  if (!hasHealthEndpoint) {
    issues.push({
      ...fromRule("missing-health-endpoint"),
      message: "No API health, readiness, or liveness route detected",
      fix: "Add a lightweight route for runtime monitoring",
    });
  }

  const authRate =
    mutatingEndpoints.length === 0
      ? 1
      : mutatingEndpoints.filter(authenticated).length /
        mutatingEndpoints.length;
  const validationRate =
    bodyEndpoints.length === 0
      ? 1
      : bodyEndpoints.filter((endpoint) =>
          hasMarker(endpoint.source, VALIDATION_MARKERS),
        ).length / bodyEndpoints.length;
  const methodClarityRate =
    endpoints.filter((endpoint) => endpoint.method !== "ALL").length /
    endpoints.length;

  const score = Math.round(
    authRate * 35 +
      validationRate * 30 +
      methodClarityRate * 20 +
      (hasHealthEndpoint ? 15 : 0),
  );

  return {
    name: "API Health",
    score,
    issues,
    summary: `${endpoints.length} Next.js handlers across ${routeFiles.length} API route files`,
  };
}
