import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import {
  type Confidence,
  createProjectIndex,
  definition,
  instanceOf,
  literalText,
  methodName,
  moduleOf,
  objectLiteral,
  type ProjectIndex,
  pluginTarget,
  propertyValue,
  receiverOf,
} from "./fastify-plugins.js";

const HTTP_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

const MUTATING_METHODS = new Set(["delete", "patch", "post", "put"]);
const BODY_METHODS = new Set(["patch", "post", "put"]);
/** Lifecycle hooks that run before the handler and can reject a request. */
const PRE_HANDLER_HOOKS = [
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
];
const AUTH_NAMES =
  /auth|permission|permit|protect|require.*(?:user|role|login)|jwt|bearer|api[-_]?key|session/i;
const VALIDATION_NAMES =
  /valid|schema|sanitize|zod|joi|yup|ajv|check(?:body|params|query)/i;
/** Plugins that add an authentication hook to the context registering them. */
const AUTH_PLUGINS = new Set(["@fastify/bearer-auth"]);
const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs,cjs}";

interface Protection {
  auth: boolean;
  validation: boolean;
}

interface Hook extends Protection {
  context: string;
}

interface Registration {
  parent: string;
  child: string;
  encapsulated: boolean;
  prefix: string;
}

interface Route extends Protection {
  context: string;
  confidence: Confidence;
  method: string;
  path: string;
  file: string;
  line: number;
}

interface RouteDeclaration {
  methods: string[];
  path: string;
  options?: ObjectLiteralExpression;
}

interface Collected {
  routes: Route[];
  registrations: Registration[];
  hooks: Hook[];
  errorHandler: boolean;
}

const NONE: Protection = { auth: false, validation: false };

function protects(texts: string[]): Protection {
  return {
    auth: texts.some((text) => AUTH_NAMES.test(text)),
    validation: texts.some((text) => VALIDATION_NAMES.test(text)),
  };
}

function either(left: Protection, right: Protection): Protection {
  return {
    auth: left.auth || right.auth,
    validation: left.validation || right.validation,
  };
}

/** A hook's text, including the body of a function it refers to by name. */
function hookText(index: ProjectIndex, node: Node): string {
  const resolved = definition(index, node);
  const own = Node.isShorthandPropertyAssignment(node) ? "" : node.getText();
  if (!resolved || resolved === node) return own;
  const text = Node.isVariableDeclaration(resolved)
    ? (resolved.getInitializer()?.getText() ?? "")
    : resolved.getText();
  return `${own} ${text}`;
}

function hasBodySchema(
  index: ProjectIndex,
  options: ObjectLiteralExpression,
): boolean {
  const schema = propertyValue(options.getProperty("schema"));
  if (!schema) return false;
  const value = objectLiteral(index, schema);
  // A schema built by a call or imported from a package gets the benefit of
  // the doubt; only a visible object without a body is reported.
  if (!value) return true;
  return (
    value.getProperty("body") !== undefined ||
    value.getProperties().some((property) => Node.isSpreadAssignment(property))
  );
}

function routeProtection(
  index: ProjectIndex,
  options: ObjectLiteralExpression | undefined,
): Protection {
  if (!options) return NONE;
  const hooks = protects(
    PRE_HANDLER_HOOKS.flatMap((hook) => {
      const value = propertyValue(options.getProperty(hook));
      return value ? [hookText(index, value)] : [];
    }),
  );
  return {
    auth: hooks.auth,
    validation: hooks.validation || hasBodySchema(index, options),
  };
}

/** A route handler: not a payload, options object, or literal value. */
function isHandler(node: Node | undefined): boolean {
  return Boolean(
    node &&
      !Node.isObjectLiteralExpression(node) &&
      !Node.isStringLiteral(node) &&
      !Node.isNoSubstitutionTemplateLiteral(node) &&
      !Node.isTemplateExpression(node) &&
      !Node.isNumericLiteral(node),
  );
}

/**
 * `fastify.post(path, [options], handler)` or `fastify.post(path, { handler })`.
 * HTTP client calls with a payload (`api.post("/users", { name })`) have no
 * handler and are not routes.
 */
function shorthandRoute(
  index: ProjectIndex,
  method: string,
  args: Node[],
): RouteDeclaration | null {
  const path = literalText(args[0]);
  if (path === null || args.length < 2) return null;
  const methods = [method];
  if (args.length > 2) {
    return isHandler(args[2])
      ? { methods, path, options: objectLiteral(index, args[1]) }
      : null;
  }
  const options = objectLiteral(index, args[1]);
  if (options) {
    return options.getProperty("handler") ? { methods, path, options } : null;
  }
  return isHandler(args[1]) ? { methods, path } : null;
}

/** `fastify.route({ method: ["POST", "PUT"], url, handler })`. */
function fullRoute(index: ProjectIndex, args: Node[]): RouteDeclaration | null {
  const options = objectLiteral(index, args[0]);
  if (!options?.getProperty("handler")) return null;
  const path = literalText(
    propertyValue(options.getProperty("url") ?? options.getProperty("path")),
  );
  const method = propertyValue(options.getProperty("method"));
  const methods = (
    Node.isArrayLiteralExpression(method) ? method.getElements() : [method]
  ).flatMap((element) => {
    const text = literalText(element);
    return text === null ? [] : [text.toLowerCase()];
  });
  return path === null || methods.length === 0
    ? null
    : { methods, path, options };
}

function collectRegistration(
  index: ProjectIndex,
  parent: string,
  args: Node[],
  collected: Collected,
): void {
  const target = pluginTarget(index, args[0]);
  const child = target ? index.plugins.get(target.fn) : undefined;
  if (target && child) {
    const prefix = literalText(
      propertyValue(objectLiteral(index, args[1])?.getProperty("prefix")),
    );
    collected.registrations.push({
      parent,
      child,
      encapsulated: target.encapsulated,
      // fastify-plugin ignores the prefix option and keeps its parent's.
      prefix: target.encapsulated ? (prefix ?? "") : "",
    });
  }
  if (args[0] && AUTH_PLUGINS.has(moduleOf(args[0]) ?? "")) {
    collected.hooks.push({ context: parent, auth: true, validation: false });
  }
}

function collectCalls(
  index: ProjectIndex,
  file: string,
  calls: CallExpression[],
  collected: Collected,
): void {
  for (const call of calls) {
    const name = methodName(call);
    // setErrorHandler() is specific enough to Fastify to accept any receiver.
    if (name === "setErrorHandler") {
      collected.errorHandler = true;
      continue;
    }
    if (
      !["register", "addHook", "route"].includes(name) &&
      !HTTP_METHODS.has(name)
    ) {
      continue;
    }
    const instance = instanceOf(index, receiverOf(call));
    if (!instance) continue;
    const args = call.getArguments();

    if (name === "register") {
      collectRegistration(index, instance.context, args, collected);
      continue;
    }
    if (name === "addHook") {
      const hook = literalText(args[0]);
      if (hook !== null && PRE_HANDLER_HOOKS.includes(hook)) {
        collected.hooks.push({
          context: instance.context,
          ...protects(args.slice(1).map((arg) => hookText(index, arg))),
        });
      }
      continue;
    }

    const route =
      name === "route"
        ? fullRoute(index, args)
        : shorthandRoute(index, name, args);
    if (!route) continue;
    const protection = routeProtection(index, route.options);
    for (const method of route.methods) {
      collected.routes.push({
        context: instance.context,
        confidence: instance.confidence,
        method,
        path: route.path,
        file,
        line: call.getStartLineNumber(),
        ...protection,
      });
    }
  }
}

/**
 * Hooks that apply to every route of a context: its own addHook() calls and
 * those of the fastify-plugin plugins it registers, which share the context.
 * Fastify attaches a context's hooks to its routes when the server is ready,
 * so the order of addHook() and route declarations does not matter.
 */
function contextHooks(
  context: string,
  collected: Collected,
  visiting: Set<string>,
): Protection {
  if (visiting.has(context)) return NONE;
  visiting.add(context);
  const protection = [
    ...collected.hooks.filter((hook) => hook.context === context),
    ...collected.registrations
      .filter(
        (registration) =>
          registration.parent === context && !registration.encapsulated,
      )
      .map((registration) =>
        contextHooks(registration.child, collected, visiting),
      ),
  ].reduce<Protection>(either, NONE);
  visiting.delete(context);
  return protection;
}

/**
 * Protection and route prefix a plugin inherits from where it is
 * registered. A plugin registered in several places is protected only if
 * every registration protects it.
 */
function inherited(
  context: string,
  collected: Collected,
  visiting: Set<string>,
): Protection & { prefix: string } {
  const parents = collected.registrations.filter(
    (registration) => registration.child === context,
  );
  if (parents.length === 0 || visiting.has(context)) {
    return { ...NONE, prefix: "" };
  }
  visiting.add(context);
  const paths = parents.map((registration) => {
    const parent = inherited(registration.parent, collected, visiting);
    return {
      ...either(
        parent,
        contextHooks(registration.parent, collected, new Set()),
      ),
      prefix: `${parent.prefix}${registration.prefix}`,
    };
  });
  visiting.delete(context);

  return {
    auth: paths.every((path) => path.auth),
    validation: paths.every((path) => path.validation),
    prefix: paths.length === 1 ? paths[0].prefix : "",
  };
}

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/** Method calls on any receiver (`x.get(...)`, `x.register(...)`) in a file. */
function memberCalls(sourceFile: SourceFile): CallExpression[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => Node.isPropertyAccessExpression(call.getExpression()));
}

export async function analyzeFastifyApi(
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

  const index = createProjectIndex(sources);
  const collected: Collected = {
    routes: [],
    registrations: [],
    hooks: [],
    errorHandler: false,
  };
  for (const { file, sourceFile } of sources) {
    collectCalls(index, file, memberCalls(sourceFile), collected);
  }

  if (collected.routes.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-fastify-routes"),
          message: "No Fastify route registrations were detected",
        },
      ],
      summary: "No Fastify endpoints detected",
    };
  }

  const endpoints = collected.routes.map((route) => {
    const parent = inherited(route.context, collected, new Set());
    const protection = either(
      either(route, parent),
      contextHooks(route.context, collected, new Set()),
    );
    return {
      ...route,
      ...protection,
      path: joinPath(parent.prefix, route.path),
    };
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
        ...fromRule("missing-auth-hook"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no recognizable auth hook`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Authenticate in an onRequest or preHandler hook on the route or its plugin",
        confidence: endpoint.confidence,
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!endpoint.validation) {
      issues.push({
        ...fromRule("missing-route-schema"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no request body schema`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Declare schema.body in the route options so Fastify validates the request",
        confidence: endpoint.confidence,
      });
    }
  }

  if (!collected.errorHandler) {
    issues.push({
      ...fromRule("missing-error-handler"),
      message: "No Fastify error handler is registered with setErrorHandler()",
      fix: "Add app.setErrorHandler((error, request, reply) => { ... }) that hides internal error details",
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
    summary: `${endpoints.length} Fastify endpoints across ${sources.length} source files`,
  };
}
