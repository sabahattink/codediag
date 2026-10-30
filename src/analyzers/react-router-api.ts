import type { SourceFile } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import { type ModuleIndex, pathAliases } from "./fastify-plugins.js";
import {
  type Handler,
  type Kind,
  NO_MODULE,
  type RouteModule,
  routeModule,
} from "./react-router-modules.js";
import { discoverRoutes, type RouteNode } from "./react-router-routes.js";

/**
 * API Health for React Router framework mode and Remix. A route module's
 * `action` answers POST, PUT, PATCH, and DELETE requests to its URL and its
 * `loader` answers GET. Middleware exported by a route runs before the
 * actions and loaders of the route and its children, so it protects them; a
 * loader's auth check protects nothing else, because loaders run in parallel
 * and a submission runs the action before any loader.
 */

const SOURCE_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}";
const HEALTH_SEGMENT =
  /^(?:health|healthz|healthcheck|live|liveness|ready|readiness)$/i;
/** Sign-in, sign-up, sign-out, and recovery routes are public by design. */
const AUTH_FLOW_SEGMENT =
  /^(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|join|forgot-?password|reset-?password|verify(?:-email)?|auth|oauth|magic-?link|onboarding)$/i;
/** Version 1 score shares. */
const AUTH_POINTS = 35;
const LOADER_POINTS = 20;
const VALIDATION_POINTS = 30;
const HEALTH_POINTS = 15;

type Sources = ReadonlyArray<{ file: string; sourceFile: SourceFile }>;

interface Endpoint {
  kind: Kind;
  file: string;
  handler: Handler;
  /** Every route the module serves. */
  routes: RouteNode[];
}

interface Verdict {
  /** The first route where the handler runs without an auth check. */
  route: RouteNode;
  /** The route module whose loader checks auth instead, if any. */
  loaderAuth: string | null;
}

function runtimeSources(context: ScanContext): Sources {
  const sources: Array<{ file: string; sourceFile: SourceFile }> = [];
  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: [
      "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
      "**/__tests__/**",
    ],
  })) {
    // A malformed source file should not prevent analysis of the rest.
    const sourceFile = context.getSourceFile(file);
    if (sourceFile) sources.push({ file, sourceFile });
  }
  return sources;
}

function moduleIndex(context: ScanContext, sources: Sources): ModuleIndex {
  const typescript = context.typescriptConfig();
  return {
    paths: new Map(sources.map(({ file, sourceFile }) => [sourceFile, file])),
    files: new Map(sources.map(({ file, sourceFile }) => [file, sourceFile])),
    // Route modules import helpers through `~/session.server`.
    aliases:
      typescript.status === "ok"
        ? pathAliases(typescript.options, context.projectPath)
        : [],
  };
}

function lineage(route: RouteNode): RouteNode[] {
  const routes: RouteNode[] = [];
  for (let node: RouteNode | null = route; node; node = node.parent) {
    routes.push(node);
  }
  return routes;
}

function hasSegment(path: string, pattern: RegExp): boolean {
  return path.split("/").some((segment) => pattern.test(segment));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function rate(passed: number, total: number): number {
  return total === 0 ? 1 : passed / total;
}

/** Route modules, analyzed once each, and what their parent routes do. */
class RouteFacts {
  private readonly modules = new Map<string, RouteModule>();

  constructor(private readonly index: ModuleIndex) {}

  module(file: string | null): RouteModule {
    if (file === null) return NO_MODULE;
    let found = this.modules.get(file);
    if (!found) {
      found = routeModule(this.index, file);
      this.modules.set(file, found);
    }
    return found;
  }

  /** Middleware on the route or a parent rejects anonymous requests. */
  guarded(route: RouteNode): boolean {
    return lineage(route).some((node) => this.module(node.file).guards);
  }

  /** The nearest route whose loader checks auth: parents only for a loader. */
  loaderAuth(route: RouteNode, kind: Kind): string | null {
    const candidates = lineage(route).slice(kind === "action" ? 0 : 1);
    return (
      candidates.find((node) => this.module(node.file).loader?.auth)?.file ??
      null
    );
  }

  /** Where a handler runs without any auth check, or null. */
  verdict(endpoint: Endpoint): Verdict | null {
    const { handler, kind } = endpoint;
    if (handler.auth) return null;
    if (kind === "action" && handler.changesSession) return null;
    if (kind === "loader" && handler.constant) return null;
    for (const route of endpoint.routes) {
      if (this.guarded(route) || hasSegment(route.path, AUTH_FLOW_SEGMENT)) {
        continue;
      }
      const loaderAuth = this.loaderAuth(route, kind);
      // A loader is reported only when a parent loader shows it was meant to be private.
      if (kind === "loader" && loaderAuth === null) continue;
      return { route, loaderAuth };
    }
    return null;
  }
}

function endpointsOf(facts: RouteFacts, nodes: readonly RouteNode[]) {
  const placements = new Map<string, RouteNode[]>();
  for (const route of nodes) {
    if (route.file === null) continue;
    placements.set(route.file, [...(placements.get(route.file) ?? []), route]);
  }
  const files = [...placements.keys()].sort();
  const endpoints = files.flatMap((file) =>
    (["action", "loader"] as const).flatMap((kind): Endpoint[] => {
      const handler = facts.module(file)[kind];
      const routes = placements.get(file) ?? [];
      return handler ? [{ kind, file, handler, routes }] : [];
    }),
  );
  return { files, endpoints };
}

function authIssue(endpoint: Endpoint, verdict: Verdict): DiagnosticIssue {
  const { path } = verdict.route;
  const location = { file: endpoint.file, line: endpoint.handler.line };
  if (verdict.loaderAuth === null) {
    return {
      ...fromRule("missing-react-router-auth"),
      message: `The action of ${path} has no recognizable auth check`,
      ...location,
      fix: "Check auth at the start of the action, for example with await requireUserId(request), or export middleware that rejects anonymous requests from this route or a parent route",
      confidence: endpoint.handler.confidence,
    };
  }
  const where =
    verdict.loaderAuth === endpoint.file
      ? "its route's loader"
      : `the loader of ${verdict.loaderAuth}`;
  return {
    ...fromRule("react-router-loader-auth-only"),
    message:
      endpoint.kind === "action"
        ? `The action of ${path} has no auth check of its own; the auth check in ${where} does not run before the action`
        : `The loader of ${path} has no auth check of its own; the auth check in ${where} runs in parallel and does not protect it`,
    ...location,
    fix: "Check auth in this handler too, for example with await requireUserId(request), or move the check into middleware on the parent route",
    // A loader's data may be meant to be public; the parent only suggests otherwise.
    confidence:
      endpoint.kind === "loader" ? "medium" : endpoint.handler.confidence,
  };
}

function validationIssue(endpoint: Endpoint): DiagnosticIssue | null {
  const { body, validated } = endpoint.handler;
  if (endpoint.kind !== "action" || !body || validated) return null;
  return {
    ...fromRule("missing-react-router-validation"),
    message: `The action of ${endpoint.routes[0]?.path ?? "/"} reads request.${body.method}() without schema validation`,
    file: endpoint.file,
    line: body.line,
    fix: "Parse the submission with a schema before using it, for example parseWithZod(formData, { schema }) from Conform or schema.safeParse(Object.fromEntries(formData))",
  };
}

function noRoutes(): AnalyzerResult {
  return {
    name: "API Health",
    score: 0,
    issues: [
      {
        ...fromRule("no-react-router-routes"),
        message: "No React Router route modules were detected",
        fix: "Declare routes in app/routes.ts with literal route(), index(), layout(), and prefix() arguments, or add route modules under app/routes",
      },
    ],
    summary: "No React Router route modules detected",
  };
}

export async function analyzeReactRouterApi(
  context: ScanContext,
): Promise<AnalyzerResult | null> {
  const sources = runtimeSources(context);
  const index = moduleIndex(context, sources);
  const tree = discoverRoutes(context, index);
  // Routes this scan cannot read are not evidence of a missing API.
  if (tree.unresolved > 0 && tree.nodes.every((node) => !node.parent)) {
    return null;
  }
  if (tree.nodes.length === 0) return noRoutes();

  const facts = new RouteFacts(index);
  const { files, endpoints } = endpointsOf(facts, tree.nodes);
  if (endpoints.length === 0) return null;

  const verdicts = new Map<Endpoint, Verdict>();
  for (const endpoint of endpoints) {
    const verdict = facts.verdict(endpoint);
    if (verdict) verdicts.set(endpoint, verdict);
  }
  const actions = endpoints.filter((endpoint) => endpoint.kind === "action");
  const loaders = endpoints.filter((endpoint) => endpoint.kind === "loader");
  // Missing auth first, then auth left to a loader: actions before loaders.
  const authIssues = [...actions, ...loaders]
    .flatMap((endpoint) => {
      const verdict = verdicts.get(endpoint);
      return verdict ? [authIssue(endpoint, verdict)] : [];
    })
    .sort((left, right) =>
      left.rule === right.rule
        ? 0
        : left.rule === "missing-react-router-auth"
          ? -1
          : 1,
    );
  const validationIssues = endpoints.flatMap(
    (endpoint) => validationIssue(endpoint) ?? [],
  );
  const hasHealthEndpoint = loaders.some((endpoint) =>
    endpoint.routes.some((route) => hasSegment(route.path, HEALTH_SEGMENT)),
  );
  const issues: DiagnosticIssue[] = [...authIssues, ...validationIssues];
  if (!hasHealthEndpoint) {
    issues.push({
      ...fromRule("missing-health-endpoint"),
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Add a resource route such as app/routes/healthz.ts whose loader returns a lightweight status",
    });
  }

  const reading = actions.filter((endpoint) => endpoint.handler.body);
  const privateLoaders = loaders.filter((endpoint) =>
    endpoint.routes.some((route) => facts.loaderAuth(route, "loader")),
  );
  const passed = (list: Endpoint[]) =>
    list.filter((endpoint) => !verdicts.has(endpoint)).length;
  const score = Math.round(
    rate(passed(actions), actions.length) * AUTH_POINTS +
      rate(passed(privateLoaders), privateLoaders.length) * LOADER_POINTS +
      rate(reading.length - validationIssues.length, reading.length) *
        VALIDATION_POINTS +
      (hasHealthEndpoint ? HEALTH_POINTS : 0),
  );

  const unresolved =
    tree.unresolved > 0
      ? `; ${tree.unresolved} route ${tree.unresolved === 1 ? "entry" : "entries"} could not be resolved statically`
      : "";
  return {
    name: "API Health",
    score,
    issues,
    summary: `${plural(endpoints.length, "React Router endpoint")} (${plural(actions.length, "action")}, ${plural(loaders.length, "loader")}) in ${plural(files.length, "route module")}${unresolved}`,
  };
}
