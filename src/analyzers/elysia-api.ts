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
  authMacros,
  contextAuthenticates,
  type ElysiaIndex,
  handlerCheck,
  hookArguments,
  hookAuthenticates,
  hookOptions,
  type Instance,
  instanceOf,
  lazyPlugin,
  pathText,
  pluginFunction,
  ROUTE_METHODS,
  type Scope,
  stringValue,
} from "./elysia-apps.js";
import {
  type ModuleIndex,
  methodName,
  moduleIndex,
  runtimeSources,
} from "./fastify-plugins.js";
import {
  either,
  isHandler,
  joinPath,
  NONE,
  nodeId,
  type Protection,
} from "./hono-apps.js";
import { functionValue } from "./react-router-handlers.js";
import { AUTH_FLOW_SEGMENT } from "./sveltekit-api.js";

const MUTATING_METHODS = new Set(["delete", "patch", "post", "put"]);
const BODY_METHODS = new Set(["patch", "post", "put"]);
const HANDLED = new Set([
  ...ROUTE_METHODS,
  "route",
  "onBeforeHandle",
  "derive",
  "resolve",
  "guard",
  "group",
  "use",
  "as",
  "onRequest",
  "onError",
]);
const HEALTH_PATH =
  /(?:^|\/)(?:health|healthz|live|ready|readiness|liveness)(?:\/|$)/i;
/** Functional plugins can use() other functional plugins; a few rounds reach them. */
const MAX_PLUGIN_ROUNDS = 4;

type Sources = ReadonlyArray<{ file: string; sourceFile: SourceFile }>;

interface Order {
  file: string;
  position: number;
}

interface RouteEvent extends Order, Protection {
  kind: "route";
  methods: string[];
  /** The path including the instance's prefix. */
  path: string;
  line: number;
  readsBody: boolean;
}

/** onBeforeHandle(), derive(), resolve(), or guard() without a callback. */
interface HookEvent extends Order, Protection {
  kind: "hook";
  scope: Scope;
  line: number;
}

/** onRequest(), which runs for every request the application serves. */
interface RequestEvent extends Order, Protection {
  kind: "request";
}

/** as("scoped") or as("global"), which lifts the instance's hooks. */
interface CastEvent extends Order {
  kind: "cast";
  scope: Scope;
}

/**
 * use(plugin), group(prefix, fn), or guard(hook, fn). An inline mount is a
 * functional plugin, which registers its hooks on the using instance itself.
 */
interface MountEvent extends Order {
  kind: "mount";
  child: string;
  prefix: string;
  inline: boolean;
  /** The hook guard() or group() applies to the routes in its callback. */
  hook: Protection;
}

type InstanceEvent =
  | RouteEvent
  | HookEvent
  | RequestEvent
  | CastEvent
  | MountEvent;

interface Collected {
  /** Each instance's registrations. */
  events: Map<string, InstanceEvent[]>;
  homes: Map<string, string>;
  routes: RouteEvent[];
  errorHandler: boolean;
}

interface Hook extends Protection {
  scope: Scope;
  file: string;
  line: number;
}

/** Why an unprotected route missed an auth hook that exists. */
interface Missed {
  reason: "local" | "late";
  file: string;
  line: number;
}

interface Placement extends Protection {
  path: string;
  missed?: Missed;
}

function add(
  collected: Collected,
  instance: Instance,
  event: InstanceEvent,
): void {
  collected.homes.set(instance.context, instance.home);
  collected.events.set(instance.context, [
    ...(collected.events.get(instance.context) ?? []),
    event,
  ]);
  if (event.kind === "route") collected.routes.push(event);
}

/** The parameter of a callback or functional plugin that receives the instance. */
function receivingParameter(
  index: ModuleIndex,
  node: Node | undefined,
): Node | undefined {
  return pluginFunction(index, node)?.getParameters()[0];
}

function callbackParameter(
  index: ModuleIndex,
  node: Node | undefined,
): string | null {
  const parameter = receivingParameter(index, node);
  return parameter ? nodeId(index, parameter) : null;
}

/** `registerRoutes(app)`: a project function given an instance registers on it. */
function helperMounts(
  index: ElysiaIndex,
  call: CallExpression,
): Array<{ instance: Instance; parameter: Node }> {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return [];
  const fn = functionValue(index, callee);
  if (!fn) return [];
  return call.getArguments().flatMap((argument, position) => {
    const parameter = fn.getParameters()[position];
    const instance = parameter ? instanceOf(index, argument) : null;
    return parameter && instance ? [{ instance, parameter }] : [];
  });
}

function routeEvent(
  index: ElysiaIndex,
  instance: Instance,
  order: Order,
  line: number,
  methods: string[],
  args: Node[],
): RouteEvent {
  const [path, handler, options] = args;
  const own = hookOptions(index, options);
  const check = isHandler(handler)
    ? handlerCheck(index, handler)
    : { ...NONE, readsBody: false };
  return {
    kind: "route",
    ...order,
    line,
    methods,
    path: joinPath(instance.prefix, pathText(index, path)),
    auth: own.auth || check.auth,
    validation: own.validation || check.validation,
    readsBody: check.readsBody,
  };
}

/**
 * use(): a plugin instance, a functional plugin that registers on the user,
 * or either one as the default export of `import("./plugin")`.
 */
function useEvent(
  index: ElysiaIndex,
  instance: Instance,
  order: Order,
  argument: Node | undefined,
): MountEvent | null {
  const plugin = lazyPlugin(index, argument) ?? argument;
  if (!plugin) return null;
  const child = instanceOf(index, plugin);
  if (child) {
    return {
      kind: "mount",
      ...order,
      child: child.context,
      prefix: instance.prefix,
      inline: false,
      hook: NONE,
    };
  }
  const parameter = receivingParameter(index, plugin);
  return parameter
    ? {
        kind: "mount",
        ...order,
        child: nodeId(index, parameter),
        prefix: instance.prefix,
        inline: true,
        hook: NONE,
      }
    : null;
}

function collectCall(
  index: ElysiaIndex,
  file: string,
  call: CallExpression,
  collected: Collected,
): void {
  const name = methodName(call);
  if (!HANDLED.has(name)) return;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const instance = instanceOf(index, callee.getExpression());
  if (!instance) return;
  const args = call.getArguments();
  const nameNode = callee.getNameNode();
  const order = { file, position: nameNode.getStart() };
  const line = nameNode.getStartLineNumber();

  if (ROUTE_METHODS.has(name)) {
    add(
      collected,
      instance,
      routeEvent(index, instance, order, line, [name], args),
    );
    return;
  }
  switch (name) {
    case "route": {
      const method = stringValue(index, args[0]);
      if (method !== null) {
        add(
          collected,
          instance,
          routeEvent(
            index,
            instance,
            order,
            line,
            [method.toLowerCase()],
            args.slice(1),
          ),
        );
      }
      return;
    }
    case "onBeforeHandle":
    case "derive":
    case "resolve": {
      const { scope, functions } = hookArguments(index, args);
      const judge =
        name === "onBeforeHandle" ? hookAuthenticates : contextAuthenticates;
      if (functions.some((fn) => judge(index, fn))) {
        add(collected, instance, {
          kind: "hook",
          ...order,
          line,
          scope,
          auth: true,
          validation: false,
        });
      }
      return;
    }
    case "guard": {
      const hook = hookOptions(index, args[0]);
      if (args.length === 1) {
        if (hook.auth || hook.validation) {
          add(collected, instance, { kind: "hook", ...order, line, ...hook });
        }
        return;
      }
      // With a callback the hook applies inside it only, even when this
      // scan cannot resolve the callback.
      const child = callbackParameter(index, args.at(-1));
      if (child) {
        add(collected, instance, {
          kind: "mount",
          ...order,
          child,
          prefix: instance.prefix,
          inline: false,
          hook,
        });
      }
      return;
    }
    case "group": {
      const child = callbackParameter(index, args.at(-1));
      if (!child) return;
      add(collected, instance, {
        kind: "mount",
        ...order,
        child,
        prefix: joinPath(instance.prefix, pathText(index, args[0])),
        inline: false,
        hook: args.length > 2 ? hookOptions(index, args[1]) : NONE,
      });
      return;
    }
    case "use": {
      const mount = useEvent(index, instance, order, args[0]);
      if (mount) add(collected, instance, mount);
      return;
    }
    case "as": {
      const scope = stringValue(index, args[0]);
      if (scope === "global" || scope === "scoped" || scope === "plugin") {
        add(collected, instance, {
          kind: "cast",
          ...order,
          scope: scope === "global" ? "global" : "scoped",
        });
      }
      return;
    }
    case "onRequest":
      if (args.some((fn) => hookAuthenticates(index, fn))) {
        add(collected, instance, {
          kind: "request",
          ...order,
          auth: true,
          validation: false,
        });
      }
      return;
    case "onError":
      collected.errorHandler = true;
      return;
  }
}

/** A project function called with an instance registers on that instance. */
function collectHelperCall(
  index: ElysiaIndex,
  file: string,
  call: CallExpression,
  collected: Collected,
): void {
  for (const { instance, parameter } of helperMounts(index, call)) {
    add(collected, instance, {
      kind: "mount",
      file,
      position: call.getStart(),
      child: nodeId(index, parameter),
      prefix: instance.prefix,
      inline: true,
      hook: NONE,
    });
  }
}

function calls(
  sources: Sources,
  test: (call: CallExpression) => boolean,
): CallExpression[] {
  return sources.flatMap(({ sourceFile }) =>
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter(test),
  );
}

const RECEIVING_METHODS = new Set(["group", "guard", "use"]);

function onInstance(index: ElysiaIndex, call: CallExpression): boolean {
  const callee = call.getExpression();
  return (
    Node.isPropertyAccessExpression(callee) &&
    instanceOf(index, callee.getExpression()) !== null
  );
}

/** Parameters a call hands an instance to, by reference or through a helper. */
function receivingParameters(index: ElysiaIndex, call: CallExpression): Node[] {
  const name = methodName(call);
  if (!RECEIVING_METHODS.has(name)) {
    return helperMounts(index, call).map(({ parameter }) => parameter);
  }
  const args = call.getArguments();
  if ((name === "guard" && args.length < 2) || !onInstance(index, call)) {
    return [];
  }
  const plugin =
    name === "use" ? (lazyPlugin(index, args[0]) ?? args[0]) : args.at(-1);
  const parameter = receivingParameter(index, plugin);
  return parameter ? [parameter] : [];
}

/**
 * The parameters that receive an instance by reference, through factories
 * and helpers, and the macros that authenticate.
 */
function elysiaIndex(base: ModuleIndex, sources: Sources): ElysiaIndex {
  const instanceParameters = new Set<Node>();
  const macros = new Set<string>();
  const index: ElysiaIndex = {
    ...base,
    instanceParameters,
    authMacros: macros,
  };
  const candidates = calls(
    sources,
    (call) =>
      RECEIVING_METHODS.has(methodName(call)) ||
      Node.isIdentifier(call.getExpression()),
  );
  for (let round = 0; round < MAX_PLUGIN_ROUNDS; round++) {
    const known = instanceParameters.size;
    for (const call of candidates) {
      for (const parameter of receivingParameters(index, call)) {
        instanceParameters.add(parameter);
      }
    }
    if (instanceParameters.size === known) break;
  }
  for (const call of calls(sources, (call) => methodName(call) === "macro")) {
    if (!onInstance(index, call)) continue;
    for (const name of authMacros(index, call)) macros.add(name);
  }
  return index;
}

function collect(index: ElysiaIndex, sources: Sources): Collected {
  const collected: Collected = {
    events: new Map(),
    homes: new Map(),
    routes: [],
    errorHandler: false,
  };
  for (const { file, sourceFile } of sources) {
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (Node.isIdentifier(call.getExpression())) {
        collectHelperCall(index, file, call, collected);
      } else {
        collectCall(index, file, call, collected);
      }
    }
  }
  // A chain's last call is visited first; report routes in source order.
  const fileOrder = new Map(sources.map(({ file }, order) => [file, order]));
  collected.routes.sort(
    (left, right) =>
      (fileOrder.get(left.file) ?? 0) - (fileOrder.get(right.file) ?? 0) ||
      left.position - right.position,
  );
  return collected;
}

/** An instance's events in registration order: its own file first, then others. */
function ordered(events: InstanceEvent[], home: string): InstanceEvent[] {
  const rank = (event: InstanceEvent) => (event.file === home ? 0 : 1);
  return [...events].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.file.localeCompare(right.file) ||
      left.position - right.position,
  );
}

/**
 * A plugin's hook as the instance that uses it sees it: a scoped hook
 * applies there as a local one, a global hook keeps applying upward, and a
 * local hook stays in the plugin.
 */
function exported(hook: Hook): Hook[] {
  if (hook.scope === "local") return [];
  return [{ ...hook, scope: hook.scope === "scoped" ? "local" : "global" }];
}

/** as("scoped") lifts local hooks; as("global") lifts every hook. */
function lift(hook: Hook, scope: Scope): Hook {
  if (scope === "global") return { ...hook, scope };
  return hook.scope === "local" ? { ...hook, scope } : hook;
}

interface Placed {
  /** Hooks registered on the instance, including ones plugins lift into it. */
  hooks: Hook[];
  /** onRequest() protection anywhere in the instance's tree. */
  requests: Protection[];
}

interface Walk {
  collected: Collected;
  visiting: Set<string>;
  placements: Array<[RouteEvent, Placement]>;
}

/** The first auth hook registered on the instance after a route. */
function lateHook(
  events: InstanceEvent[],
  route: RouteEvent,
): Missed | undefined {
  const late = events
    .slice(events.indexOf(route) + 1)
    .find((event) => event.kind === "hook" && event.auth);
  return late?.kind === "hook"
    ? { reason: "late", file: late.file, line: late.line }
    : undefined;
}

/**
 * Replays an instance's registrations in order. Elysia applies a hook to the
 * routes registered after it, including routes of plugins used after it;
 * a plugin's hooks reach the instance that uses it only when scoped or
 * global, and only for routes registered after the use().
 */
function place(
  walk: Walk,
  context: string,
  prefix: string,
  inherited: Protection[],
): Placed {
  if (walk.visiting.has(context)) return { hooks: [], requests: [] };
  walk.visiting.add(context);
  const events = ordered(
    walk.collected.events.get(context) ?? [],
    walk.collected.homes.get(context) ?? "",
  );
  let hooks: Hook[] = [];
  let active: Protection[] = [...inherited];
  /** Auth hooks of used plugins that stayed local to them. */
  let stranded: Hook[] = [];
  const requests: Protection[] = [];
  for (const event of events) {
    if (event.kind === "hook") {
      hooks = [...hooks, event];
      active = [...active, event];
    } else if (event.kind === "cast") {
      hooks = hooks.map((hook) => lift(hook, event.scope));
    } else if (event.kind === "request") {
      requests.push(event);
    } else if (event.kind === "mount") {
      const child = place(walk, event.child, joinPath(prefix, event.prefix), [
        ...active,
        event.hook,
      ]);
      requests.push(...child.requests);
      const lifted = event.inline ? child.hooks : child.hooks.flatMap(exported);
      hooks = [...hooks, ...lifted];
      active = [...active, ...lifted];
      // A plugin with hooks and no routes of its own exists to protect the
      // instance that uses it, which its local hooks never do.
      const routes = walk.collected.events.get(event.child) ?? [];
      if (!event.inline && !routes.some((child) => child.kind === "route")) {
        stranded = [
          ...stranded,
          ...child.hooks.filter((hook) => hook.auth && hook.scope === "local"),
        ];
      }
    } else {
      const protection = active.reduce<Protection>(either, event);
      const local = stranded[0];
      walk.placements.push([
        event,
        {
          path: joinPath(prefix, event.path),
          auth: protection.auth,
          validation: protection.validation,
          missed: local
            ? { reason: "local", file: local.file, line: local.line }
            : lateHook(events, event),
        },
      ]);
    }
  }
  walk.visiting.delete(context);
  return { hooks, requests };
}

/**
 * Every place each route is served from, starting at instances nobody uses.
 * onRequest() runs for every request of the application it is part of,
 * wherever and whenever it is registered.
 */
function placeRoutes(collected: Collected): Map<RouteEvent, Placement[]> {
  const placements = new Map<RouteEvent, Placement[]>();
  const placeFrom = (root: string) => {
    const walk: Walk = { collected, visiting: new Set(), placements: [] };
    const { requests } = place(walk, root, "", []);
    const authenticated = requests.some((request) => request.auth);
    for (const [route, placement] of walk.placements) {
      placements.set(route, [
        ...(placements.get(route) ?? []),
        authenticated ? { ...placement, auth: true } : placement,
      ]);
    }
  };
  const children = new Set(
    [...collected.events.values()]
      .flat()
      .flatMap((event) => (event.kind === "mount" ? [event.child] : [])),
  );
  for (const context of collected.events.keys()) {
    if (!children.has(context)) placeFrom(context);
  }
  // Instances that only use each other in a cycle are analyzed on their own.
  for (const [context, events] of collected.events) {
    if (
      events.some((event) => event.kind === "route" && !placements.has(event))
    ) {
      placeFrom(context);
    }
  }
  return placements;
}

function authMessage(method: string, path: string, missed?: Missed): string {
  const base = `${method.toUpperCase()} ${path} has no recognizable auth check`;
  if (!missed) return base;
  const hook = `the auth hook at ${missed.file}:${missed.line}`;
  return missed.reason === "local"
    ? `${base}: ${hook} is local to its plugin, so it does not reach this route`
    : `${base}: ${hook} is registered after this route, and Elysia applies hooks only to routes registered after them`;
}

function authFix(missed?: Missed): string {
  if (missed?.reason === "local") {
    return "Register the plugin's hook with { as: 'scoped' } (or { as: 'global' }), or call .as('scoped') on the plugin, so it applies to the instance that uses it";
  }
  if (missed?.reason === "late") {
    return "Register the auth hook before this route, or use() the plugin that adds it before the route";
  }
  return "Reject anonymous requests before the handler: an onBeforeHandle() or resolve() that returns status(401), an auth macro such as { auth: true }, or a check in the handler";
}

export async function analyzeElysiaApi(
  context: ScanContext,
): Promise<AnalyzerResult> {
  const sources = runtimeSources(context);
  const index = elysiaIndex(moduleIndex(context, sources), sources);
  const collected = collect(index, sources);

  if (collected.routes.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-elysia-routes"),
          message: "No Elysia route registrations were detected",
        },
      ],
      summary: "No Elysia endpoints detected",
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
      missed: unprotected?.missed,
      validationPath: (unvalidated ?? placed[0])?.path ?? route.path,
      paths: placed.map((placement) => placement.path),
    }));
  });

  // Sign-in, sign-up, sign-out, and recovery routes are public by design.
  const mutatingEndpoints = endpoints.filter(
    (endpoint) =>
      MUTATING_METHODS.has(endpoint.method) &&
      !endpoint.paths.some((path) =>
        path.split("/").some((segment) => AUTH_FLOW_SEGMENT.test(segment)),
      ),
  );
  const bodyEndpoints = endpoints.filter(
    (endpoint) => BODY_METHODS.has(endpoint.method) && endpoint.readsBody,
  );
  const issues: DiagnosticIssue[] = [];

  for (const endpoint of mutatingEndpoints) {
    if (!endpoint.auth) {
      issues.push({
        ...fromRule("missing-elysia-auth"),
        message: authMessage(
          endpoint.method,
          endpoint.authPath,
          endpoint.missed,
        ),
        file: endpoint.file,
        line: endpoint.line,
        fix: authFix(endpoint.missed),
        confidence: "high",
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!endpoint.validation) {
      issues.push({
        ...fromRule("missing-elysia-validation"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.validationPath} reads the request body without a schema`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Add a body schema to the route options, such as { body: t.Object({ ... }) } or a Zod schema, or a guard({ body }) registered before the route",
        confidence: "high",
      });
    }
  }

  if (!collected.errorHandler) {
    issues.push({
      ...fromRule("missing-elysia-error-handler"),
      message: "No Elysia error handler is registered with onError()",
      fix: "Add .onError(({ code, error }) => ...) that logs the error and returns your API's error format",
    });
  }

  const hasHealthEndpoint = endpoints.some((endpoint) =>
    endpoint.paths.some((path) => HEALTH_PATH.test(path)),
  );
  if (!hasHealthEndpoint) {
    issues.push({
      ...fromRule("missing-health-endpoint"),
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Expose a lightweight health endpoint for runtime monitoring",
    });
  }

  const rate = (items: Array<{ ok: boolean }>) =>
    items.length === 0
      ? 1
      : items.filter((item) => item.ok).length / items.length;
  const authRate = rate(
    mutatingEndpoints.map((endpoint) => ({ ok: endpoint.auth })),
  );
  const validationRate = rate(
    bodyEndpoints.map((endpoint) => ({ ok: endpoint.validation })),
  );
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
    summary: `${endpoints.length} Elysia endpoints across ${sources.length} source files`,
  };
}
