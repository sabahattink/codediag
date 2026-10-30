import {
  type CallExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import {
  type Confidence,
  definition,
  type FunctionLike,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  methodName,
  moduleOf,
  unwrap,
} from "./fastify-plugins.js";
import {
  appParameters,
  either,
  handlerArguments,
  type Instance,
  instanceOf,
  isHandler,
  joinPath,
  literals,
  nodeId,
  openapiRoute,
  type Protection,
  protects,
  ROUTE_METHODS,
  walkChain,
} from "./hono-apps.js";

const MUTATING_METHODS = new Set(["delete", "patch", "post", "put"]);
const BODY_METHODS = new Set(["patch", "post", "put"]);
const APP_METHODS = new Set(["on", "use", "route", "onError", "openapi"]);
const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs,cjs}";
const TRPC_SERVER = "@hono/trpc-server";

interface Order {
  file: string;
  position: number;
}

interface RouteEvent extends Order, Protection {
  kind: "route";
  methods: string[];
  /** The path including the receiver's basePath(). */
  path: string;
  line: number;
  confidence: Confidence;
  /** The trpcServer() call a tRPC mount passes to use(); not a route itself. */
  trpc?: CallExpression;
}

interface UseEvent extends Order, Protection {
  kind: "use";
  path: string;
}

/** app.route(prefix, child), or a call passing the app to a Hono parameter. */
interface MountEvent extends Order {
  kind: "mount";
  child: string;
  prefix: string;
}

type AppEvent = RouteEvent | UseEvent | MountEvent;

interface Collected {
  /** Each app's registrations, by the router they are added to. */
  events: Map<string, AppEvent[]>;
  homes: Map<string, string>;
  routes: RouteEvent[];
  /** use() calls that mount tRPC, placed like routes to find their middleware. */
  trpc: RouteEvent[];
  errorHandler: boolean;
}

interface Placement extends Protection {
  path: string;
}

function add(collected: Collected, app: Instance, event: AppEvent): void {
  collected.homes.set(app.context, app.home);
  collected.events.set(app.context, [
    ...(collected.events.get(app.context) ?? []),
    event,
  ]);
  if (event.kind === "route") {
    (event.trpc ? collected.trpc : collected.routes).push(event);
  }
}

/** The trpcServer() call a use() argument is, directly or through a variable. */
function trpcServerCall(
  index: ModuleIndex,
  node: Node,
): CallExpression | undefined {
  const resolved = definition(index, node);
  const value = Node.isVariableDeclaration(resolved)
    ? resolved.getInitializer()
    : resolved;
  const call = value && unwrap(value);
  return Node.isCallExpression(call) &&
    moduleOf(call.getExpression()) === TRPC_SERVER
    ? call
    : undefined;
}

function collectAppCall(
  index: ModuleIndex,
  file: string,
  call: CallExpression,
  collected: Collected,
): void {
  const name = methodName(call);
  if (!ROUTE_METHODS.has(name) && !APP_METHODS.has(name)) return;
  const receiver = call.getExpression();
  if (!Node.isPropertyAccessExpression(receiver)) return;
  const app = instanceOf(index, receiver.getExpression());
  if (!app) return;
  const args = call.getArguments();
  const nameNode = receiver.getNameNode();
  const order = { file, position: nameNode.getStart() };

  if (name === "onError") {
    collected.errorHandler = true;
    return;
  }
  if (name === "route") {
    const child = args[1] && instanceOf(index, args[1]);
    if (!child) return;
    collected.homes.set(child.context, child.home);
    add(collected, app, {
      kind: "mount",
      ...order,
      child: child.context,
      prefix: joinPath(app.basePath, literalText(args[0]) ?? ""),
    });
    return;
  }
  if (name === "use") {
    const path = literalText(args[0]);
    const handlers = path === null ? args : args.slice(1);
    const mount = handlers.findIndex((arg) => trpcServerCall(index, arg));
    const trpc = handlers[mount] && trpcServerCall(index, handlers[mount]);
    if (trpc) {
      // Middleware before trpcServer() in the same use() runs before it.
      add(collected, app, {
        kind: "route",
        ...order,
        methods: ["all"],
        path: joinPath(app.basePath, path ?? "*"),
        line: nameNode.getStartLineNumber(),
        confidence: app.confidence,
        trpc,
        ...protects(index, handlers.slice(0, mount)),
      });
    }
    add(collected, app, {
      kind: "use",
      ...order,
      path: joinPath(app.basePath, path ?? "*"),
      ...protects(index, path === null ? args : args.slice(1)),
    });
    return;
  }

  const base = {
    kind: "route" as const,
    ...order,
    line: nameNode.getStartLineNumber(),
    confidence: app.confidence,
  };
  if (name === "openapi") {
    const route = openapiRoute(index, args);
    if (route) {
      add(collected, app, {
        ...base,
        ...route,
        path: joinPath(app.basePath, route.path),
      });
    }
    return;
  }
  // QUERY is too generic a method name to trust on a receiver matched by name.
  if (name === "query" && app.confidence !== "high") return;

  // app.get("/books", list).post(create) reuses the previous path.
  const [methods, paths, handlers] =
    name === "on"
      ? [
          literals(args[0]).map((method) => method.toLowerCase()),
          literals(args[1]),
          handlerArguments(args.slice(2)),
        ]
      : literalText(args[0]) !== null
        ? [[name], literals(args[0]), handlerArguments(args.slice(1))]
        : [
            [name],
            [walkChain(receiver.getExpression()).path ?? ""].filter(
              (path) => path !== "",
            ),
            handlerArguments(args),
          ];
  if (methods.length === 0 || !isHandler(handlers.at(-1))) return;
  // The last handler answers the request; the ones before it run first.
  const protection = protects(index, handlers.slice(0, -1));
  for (const path of paths) {
    add(collected, app, {
      ...base,
      methods,
      path: joinPath(app.basePath, path),
      ...protection,
    });
  }
}

/** `registerUsers(app)` where registerUsers takes a Hono-typed parameter. */
function collectAppArgument(
  index: ModuleIndex,
  file: string,
  call: CallExpression,
  functions: ReadonlyMap<FunctionLike, number[]>,
  collected: Collected,
): void {
  const fn = definition(index, call.getExpression());
  if (!isFunctionLike(fn)) return;
  const positions = functions.get(fn);
  if (!positions) return;
  for (const position of positions) {
    const argument = call.getArguments()[position];
    const parameter = fn.getParameters()[position];
    const app = argument && instanceOf(index, argument);
    if (!parameter || !app || app.confidence !== "high") continue;
    const child = nodeId(index, parameter);
    collected.homes.set(child, index.paths.get(fn.getSourceFile()) ?? "");
    add(collected, app, {
      kind: "mount",
      file,
      position: call.getStart(),
      child,
      prefix: app.basePath,
    });
  }
}

/** Matches route paths like Hono's router matches a middleware path. */
function pathPattern(path: string): RegExp {
  const source = path.replace(
    /\/\*$|\*|:[^/{}?]+(?:\{[^}]*\})?\??|[.+?^${}()|[\]\\]/g,
    (token) =>
      token === "/*"
        ? "(?:|/.*)"
        : token === "*"
          ? ".*"
          : token.startsWith(":")
            ? "[^/]+"
            : `\\${token}`,
  );
  return new RegExp(`^${source}$`);
}

/** An app's events in registration order: its own file first, then others. */
function ordered(events: AppEvent[], home: string): AppEvent[] {
  const rank = (event: AppEvent) => (event.file === home ? 0 : 1);
  return [...events].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.file.localeCompare(right.file) ||
      left.position - right.position,
  );
}

/**
 * Replays an app's registrations in order. app.route() copies a child's
 * routes and middleware into the parent at that point, and Hono runs the
 * middleware registered before a route whose path matches it; middleware
 * registered after the route never runs for it.
 */
function place(
  collected: Collected,
  context: string,
  prefix: string,
  active: Array<{ pattern: RegExp; protection: Protection }>,
  visiting: Set<string>,
  placements: Map<RouteEvent, Placement[]>,
): void {
  if (visiting.has(context)) return;
  visiting.add(context);
  const events = collected.events.get(context) ?? [];
  for (const event of ordered(events, collected.homes.get(context) ?? "")) {
    if (event.kind === "use") {
      active.push({
        pattern: pathPattern(joinPath(prefix, event.path)),
        protection: event,
      });
    } else if (event.kind === "mount") {
      const childPrefix = joinPath(prefix, event.prefix);
      place(collected, event.child, childPrefix, active, visiting, placements);
    } else {
      const path = joinPath(prefix, event.path);
      const protection = active
        .filter((use) => use.pattern.test(path))
        .map((use) => use.protection)
        .reduce<Protection>(either, event);
      placements.set(event, [
        ...(placements.get(event) ?? []),
        { path, auth: protection.auth, validation: protection.validation },
      ]);
    }
  }
  visiting.delete(context);
}

/** Every place each route is served from, starting at apps nobody mounts. */
function placeRoutes(collected: Collected): Map<RouteEvent, Placement[]> {
  const placements = new Map<RouteEvent, Placement[]>();
  const children = new Set(
    [...collected.events.values()]
      .flat()
      .flatMap((event) => (event.kind === "mount" ? [event.child] : [])),
  );
  const roots = [...collected.events.keys()].filter(
    (context) => !children.has(context),
  );
  for (const root of roots) {
    place(collected, root, "", [], new Set(), placements);
  }
  // Apps that only mount each other in a cycle are analyzed on their own.
  for (const [context, events] of collected.events) {
    if (
      events.some((event) => event.kind === "route" && !placements.has(event))
    ) {
      place(collected, context, "", [], new Set(), placements);
    }
  }
  return placements;
}

function collect(
  index: ModuleIndex,
  sources: ReadonlyArray<{ file: string; sourceFile: SourceFile }>,
): Collected {
  const collected: Collected = {
    events: new Map(),
    homes: new Map(),
    routes: [],
    trpc: [],
    errorHandler: false,
  };
  const functions = new Map(
    sources.flatMap(({ sourceFile }) => [...appParameters(sourceFile)]),
  );
  for (const { file, sourceFile } of sources) {
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (Node.isPropertyAccessExpression(call.getExpression())) {
        collectAppCall(index, file, call, collected);
      } else if (
        functions.size > 0 &&
        Node.isIdentifier(call.getExpression())
      ) {
        collectAppArgument(index, file, call, functions, collected);
      }
    }
  }
  const fileOrder = new Map(sources.map(({ file }, order) => [file, order]));
  collected.routes.sort(
    (left, right) =>
      (fileOrder.get(left.file) ?? 0) - (fileOrder.get(right.file) ?? 0) ||
      left.position - right.position,
  );
  return collected;
}

/**
 * Whether auth middleware runs before each tRPC mount, by its trpcServer()
 * call. A mount served from several places is protected only if every place
 * is.
 */
export function honoTrpcMounts(
  index: ModuleIndex,
  sources: ReadonlyArray<{ file: string; sourceFile: SourceFile }>,
): ReadonlyMap<Node, boolean> {
  const collected = collect(index, sources);
  if (collected.trpc.length === 0) return new Map();
  const placements = placeRoutes(collected);
  return new Map(
    collected.trpc.flatMap((event) =>
      event.trpc
        ? [
            [
              event.trpc,
              (placements.get(event) ?? [event]).every(
                (placement) => placement.auth,
              ),
            ] as const,
          ]
        : [],
    ),
  );
}

export async function analyzeHonoApi(
  context: ScanContext,
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const sources: Array<{ file: string; sourceFile: SourceFile }> = [];
  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: [
      "**/*.test.{ts,tsx,js,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,mjs,cjs}",
      "**/__tests__/**",
    ],
  })) {
    // A malformed source file should not prevent analysis of the rest.
    const sourceFile = context.getSourceFile(file);
    if (sourceFile) sources.push({ file, sourceFile });
  }

  const index: ModuleIndex = {
    paths: new Map(sources.map(({ file, sourceFile }) => [sourceFile, file])),
    files: new Map(sources.map(({ file, sourceFile }) => [file, sourceFile])),
  };
  const collected = collect(index, sources);

  if (collected.routes.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-hono-routes"),
          message: "No Hono route registrations were detected",
        },
      ],
      summary: "No Hono endpoints detected",
    };
  }

  // A route served from several places is protected only if every place is.
  const placements = placeRoutes(collected);
  const endpoints = collected.routes.flatMap((route) => {
    const placed = placements.get(route) ?? [{ ...route }];
    const unprotected = placed.find((placement) => !placement.auth);
    const unvalidated = placed.find((placement) => !placement.validation);
    return route.methods.map((method) => ({
      ...route,
      method,
      auth: !unprotected,
      validation: !unvalidated,
      authPath: (unprotected ?? placed[0])?.path ?? route.path,
      validationPath: (unvalidated ?? placed[0])?.path ?? route.path,
      paths: placed.map((placement) => placement.path),
    }));
  });

  const mutatingEndpoints = endpoints.filter((endpoint) =>
    MUTATING_METHODS.has(endpoint.method),
  );
  const bodyEndpoints = endpoints.filter((endpoint) =>
    BODY_METHODS.has(endpoint.method),
  );

  for (const endpoint of mutatingEndpoints) {
    if (!endpoint.auth) {
      issues.push({
        ...fromRule("missing-hono-auth-middleware"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.authPath} has no recognizable auth middleware`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Add auth middleware such as jwt() or bearerAuth() to the route, or app.use() it for the route's path before the route is registered",
        confidence: endpoint.confidence,
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!endpoint.validation) {
      issues.push({
        ...fromRule("missing-hono-validator"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.validationPath} has no json or form validator`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Validate the body before the handler, for example with zValidator('json', schema)",
        confidence: endpoint.confidence,
      });
    }
  }

  if (!collected.errorHandler) {
    issues.push({
      ...fromRule("missing-hono-error-handler"),
      message: "No Hono error handler is registered with onError()",
      fix: "Add app.onError((error, c) => ...) that logs the error and returns your API's error format",
    });
  }

  const hasHealthEndpoint = endpoints.some((endpoint) =>
    endpoint.paths.some((path) =>
      /(?:^|\/)(?:health|healthz|live|ready|readiness|liveness)(?:\/|$)/i.test(
        path,
      ),
    ),
  );
  if (!hasHealthEndpoint) {
    issues.push({
      ...fromRule("missing-health-endpoint"),
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Expose a lightweight health endpoint for runtime monitoring",
    });
  }

  const authRate =
    mutatingEndpoints.length === 0
      ? 1
      : mutatingEndpoints.filter((endpoint) => endpoint.auth).length /
        mutatingEndpoints.length;
  const validationRate =
    bodyEndpoints.length === 0
      ? 1
      : bodyEndpoints.filter((endpoint) => endpoint.validation).length /
        bodyEndpoints.length;

  const score = Math.round(
    authRate * 35 +
      validationRate * 30 +
      (collected.errorHandler ? 20 : 0) +
      (hasHealthEndpoint ? 15 : 0),
  );

  return {
    name: "API Health",
    score,
    issues,
    summary: `${endpoints.length} Hono endpoints across ${sources.length} source files`,
  };
}
