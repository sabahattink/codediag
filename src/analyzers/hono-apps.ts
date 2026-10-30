import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  type Confidence,
  definition,
  type FunctionLike,
  importSource,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  methodName,
  moduleOf,
  objectLiteral,
  propertyValue,
  unwrap,
} from "./fastify-plugins.js";

/**
 * Resolves Hono apps across a project: which expressions are an app, which
 * router they share (basePath() clones share their parent's), what a route
 * declaration's arguments are, and whether middleware authenticates or
 * validates the request body.
 */

/** Packages that export a Hono class: the presets and OpenAPIHono. */
const HONO_MODULES = new Set([
  "hono",
  "hono/tiny",
  "hono/quick",
  "@hono/zod-openapi",
]);
const HONO_TYPE = /^(?:[A-Za-z_$][\w$]*\.)?(?:OpenAPI)?Hono\b/;
/** Receivers matched only by name, when their creation cannot be resolved. */
const INSTANCE_NAMES = /(?:^|\.)(?:app|api|hono|router)$/i;
/** Variables initialized from an HTTP client, such as `ky.create()` or `hc()`. */
const HTTP_CLIENT =
  /\b(?:axios|got|ky|superagent|ofetch|undici|needle|hc)\b|\bfetch\s*\(|\.create\s*\(/;
/** Route registration methods of a Hono app. */
export const ROUTE_METHODS = new Set([
  "all",
  "delete",
  "get",
  "options",
  "patch",
  "post",
  "put",
  "query",
]);
/** Methods that return the app they are called on, so calls can be chained. */
const CHAINABLE = new Set([
  ...ROUTE_METHODS,
  "on",
  "use",
  "route",
  "onError",
  "notFound",
  "openapi",
  "mount",
  "doc",
  "doc31",
]);
/** Auth middleware by package, matched by the imported name. */
const AUTH_MIDDLEWARE: Readonly<Record<string, readonly string[]>> = {
  "hono/basic-auth": ["basicAuth"],
  "hono/bearer-auth": ["bearerAuth"],
  "hono/jwk": ["jwk"],
  "hono/jwt": ["jwt"],
  "@hono/auth-js": ["verifyAuth"],
  "@hono/clerk-auth": ["clerkMiddleware"],
  "@hono/firebase-auth": ["verifyFirebaseAuth"],
  "@hono/oidc-auth": ["oidcAuthMiddleware"],
};
/** Validator middleware by package; the first argument is the target. */
const VALIDATORS: Readonly<Record<string, string>> = {
  "hono/validator": "validator",
  "@hono/ajv-validator": "ajvValidator",
  "@hono/arktype-validator": "arktypeValidator",
  "@hono/class-validator": "classValidator",
  "@hono/effect-validator": "effectValidator",
  "@hono/standard-validator": "sValidator",
  "@hono/typebox-validator": "tbValidator",
  "@hono/typia-validator": "typiaValidator",
  "@hono/valibot-validator": "vValidator",
  "@hono/zod-validator": "zValidator",
};
const VALIDATOR_NAME = /^(?:[A-Za-z_$][\w$]*Validator|validator)$/;
/** Validation targets that hold the request body. */
const BODY_TARGETS = new Set(["json", "form"]);
const AUTH_NAMES =
  /auth|permission|permit|protect|require.*(?:user|role|login)|jwt|bearer|api[-_]?key/i;
const VALIDATION_NAMES =
  /valid|schema|sanitize|zod|joi|yup|ajv|check(?:body|params|query)/i;
/** Bounds alias, import, and factory chains; real code needs a few hops. */
const MAX_RESOLUTION_DEPTH = 8;

export interface Instance {
  /** The app's router; basePath() clones share their parent's. */
  context: string;
  /** The file that creates or declares the app. */
  home: string;
  /** The prefix basePath() adds to paths registered on this receiver. */
  basePath: string;
  confidence: Confidence;
}

export interface Protection {
  auth: boolean;
  validation: boolean;
}

export const NONE: Protection = { auth: false, validation: false };

export function either(left: Protection, right: Protection): Protection {
  return {
    auth: left.auth || right.auth,
    validation: left.validation || right.validation,
  };
}

/** Joins route paths like Hono's mergePath, without a trailing slash. */
export function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

interface Chain {
  root: Node;
  basePath: string;
  /** The path of the nearest route call, which path-less routes reuse. */
  path: string | null;
}

/**
 * Follows calls that return their receiver back to the app expression, as in
 * `app.basePath("/v1").get(...)`, collecting basePath() segments on the way.
 */
export function walkChain(node: Node): Chain {
  const segments: string[] = [];
  let path: string | null = null;
  let current = unwrap(node);
  while (Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    const name = callee.getName();
    const [first, second] = current.getArguments();
    if (name === "basePath") {
      segments.unshift(literalText(first) ?? "");
      // A basePath() clone starts without a current path.
      path ??= "";
    } else if (!CHAINABLE.has(name)) {
      break;
    } else if (
      path === null &&
      (ROUTE_METHODS.has(name) || name === "on" || name === "use")
    ) {
      path = literalText(name === "on" ? second : first);
    }
    current = unwrap(callee.getExpression());
  }
  return { root: current, basePath: segments.reduce(joinPath, ""), path };
}

export function nodeId(index: ModuleIndex, node: Node): string {
  return `${index.paths.get(node.getSourceFile())}:${node.getStart()}`;
}

function homeOf(index: ModuleIndex, node: Node): string {
  return index.paths.get(node.getSourceFile()) ?? "";
}

function createsApp(node: Node): boolean {
  return (
    Node.isNewExpression(node) &&
    HONO_MODULES.has(moduleOf(node.getExpression()) ?? "")
  );
}

export function isHonoTyped(node: Node): boolean {
  return (
    (Node.isParameterDeclaration(node) ||
      Node.isVariableDeclaration(node) ||
      Node.isPropertyDeclaration(node)) &&
    HONO_TYPE.test(node.getTypeNode()?.getText() ?? "")
  );
}

/** Expressions a function returns: its expression body or return statements. */
function returnedValues(fn: FunctionLike): Node[] {
  const body = fn.getBody();
  if (body && !Node.isBlock(body)) return [body];
  return fn
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter(
      (statement) =>
        statement.getFirstAncestor((ancestor) => isFunctionLike(ancestor)) ===
        fn,
    )
    .flatMap((statement) => statement.getExpression() ?? []);
}

/** The declaration `this.app` or `server.app` refers to, if any. */
function propertyDeclaration(node: Node): Node | undefined {
  if (!Node.isPropertyAccessExpression(node)) return undefined;
  return node.getNameNode().getSymbol()?.getDeclarations()[0];
}

/** An app resolved from its creation or a Hono type; never by name. */
function resolveApp(
  index: ModuleIndex,
  root: Node,
  depth: number,
): Instance | null {
  const value = propertyDeclaration(root) ?? definition(index, root);
  if (!value) return null;
  const typed = isHonoTyped(value)
    ? {
        context: nodeId(index, value),
        home: homeOf(index, value),
        basePath: "",
        confidence: "high" as const,
      }
    : null;
  if (createsApp(value)) {
    return {
      context: nodeId(index, value),
      home: homeOf(index, value),
      basePath: "",
      confidence: "high",
    };
  }
  if (Node.isVariableDeclaration(value) || Node.isPropertyDeclaration(value)) {
    const initializer = value.getInitializer();
    // const v1 = app.basePath("/v1"), const app = createApp()
    const created = initializer && instanceOf(index, initializer, depth + 1);
    return created?.confidence === "high" ? created : typed;
  }
  if (typed) return typed;
  if (Node.isCallExpression(value)) {
    // An app returned by a factory function in the project.
    const fn = definition(index, value.getExpression());
    if (!isFunctionLike(fn)) return null;
    for (const returned of returnedValues(fn)) {
      const app = instanceOf(index, returned, depth + 1);
      if (app?.confidence === "high") return app;
    }
  }
  return null;
}

/**
 * The app a receiver belongs to. Apps created with `new Hono()` or declared
 * with a Hono type are high confidence; receivers named like an app (`app`,
 * `this.router`) fall back to low confidence.
 */
export function instanceOf(
  index: ModuleIndex,
  receiver: Node,
  depth = 0,
): Instance | null {
  const chain = walkChain(receiver);
  const app =
    depth > MAX_RESOLUTION_DEPTH ? null : resolveApp(index, chain.root, depth);
  if (app) {
    return { ...app, basePath: joinPath(app.basePath, chain.basePath) };
  }
  const declared = definition(index, chain.root);
  if (
    Node.isVariableDeclaration(declared) &&
    HTTP_CLIENT.test(declared.getInitializer()?.getText() ?? "")
  ) {
    return null;
  }
  const text = chain.root.getText();
  if (!INSTANCE_NAMES.test(text)) return null;
  const home = homeOf(index, chain.root);
  return {
    context: `${home}#${text}`,
    home,
    basePath: chain.basePath,
    confidence: "low",
  };
}

/** Functions with Hono-typed parameters, by the indexes of those parameters. */
export function appParameters(
  sourceFile: SourceFile,
): Map<FunctionLike, number[]> {
  const functions = new Map<FunctionLike, number[]>();
  for (const parameter of sourceFile.getDescendantsOfKind(
    SyntaxKind.Parameter,
  )) {
    const fn = parameter.getParent();
    if (!isFunctionLike(fn) || !isHonoTyped(parameter)) continue;
    functions.set(fn, [
      ...(functions.get(fn) ?? []),
      fn.getParameters().indexOf(parameter),
    ]);
  }
  return functions;
}

/** The package and export name a called identifier was imported as. */
function importedCallee(
  call: CallExpression,
): { specifier: string; name: string } | null {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return null;
  const declaration = callee.getSymbol()?.getDeclarations()[0];
  return declaration ? importSource(declaration) : null;
}

function validatesBody(call: CallExpression): boolean {
  // A target chosen at runtime gets the benefit of the doubt.
  const target = literalText(call.getArguments()[0]);
  return target === null || BODY_TARGETS.has(target);
}

/** Protection known from a middleware factory's package, or null. */
function knownProtection(node: Node): Protection | null {
  if (!Node.isCallExpression(node)) return null;
  const imported = importedCallee(node);
  if (imported && VALIDATORS[imported.specifier] === imported.name) {
    return { auth: false, validation: validatesBody(node) };
  }
  const authNames = imported ? AUTH_MIDDLEWARE[imported.specifier] : undefined;
  if (imported && authNames) {
    return { auth: authNames.includes(imported.name), validation: false };
  }
  return VALIDATOR_NAME.test(node.getExpression().getText())
    ? { auth: false, validation: validatesBody(node) }
    : null;
}

/**
 * What a middleware argument does. Middleware from a known package is judged
 * by its export; anything else by names, where auth also looks into the
 * definition of a named middleware (`requireAdmin` checking the JWT payload).
 */
export function middlewareProtection(
  index: ModuleIndex,
  node: Node,
): Protection {
  const value = unwrap(node);
  const known = knownProtection(value);
  if (known) return known;
  // const guard = jwt({ ... }) is judged like jwt({ ... }) itself.
  const resolved = definition(index, value);
  const initializer = Node.isVariableDeclaration(resolved)
    ? resolved.getInitializer()
    : undefined;
  const inner = initializer && knownProtection(unwrap(initializer));
  if (inner) return inner;
  const own = Node.isShorthandPropertyAssignment(value) ? "" : value.getText();
  const body =
    resolved && resolved !== value ? (initializer ?? resolved).getText() : "";
  return {
    auth: AUTH_NAMES.test(own) || AUTH_NAMES.test(body),
    validation: VALIDATION_NAMES.test(own),
  };
}

/** A route's methods, path, and the protection its declaration carries. */
export interface RouteDeclaration extends Protection {
  methods: string[];
  path: string;
}

export function protects(index: ModuleIndex, nodes: Node[]): Protection {
  return nodes
    .map((node) => middlewareProtection(index, node))
    .reduce(either, NONE);
}

/** A route handler: not a payload, options object, or literal value. */
export function isHandler(node: Node | undefined): boolean {
  return Boolean(
    node &&
      !Node.isObjectLiteralExpression(node) &&
      !Node.isStringLiteral(node) &&
      !Node.isNoSubstitutionTemplateLiteral(node) &&
      !Node.isTemplateExpression(node) &&
      !Node.isNumericLiteral(node),
  );
}

/** Route arguments, with `...factory.createHandlers(a, b)` spread in place. */
export function handlerArguments(args: Node[]): Node[] {
  return args.flatMap((arg) => {
    if (!Node.isSpreadElement(arg)) return [arg];
    const spread = unwrap(arg.getExpression());
    return Node.isCallExpression(spread) &&
      methodName(spread) === "createHandlers"
      ? spread.getArguments()
      : [arg];
  });
}

export function literals(node: Node | undefined): string[] {
  const value = node && unwrap(node);
  const elements = Node.isArrayLiteralExpression(value)
    ? value.getElements()
    : [value];
  return elements.flatMap((element) => literalText(element) ?? []);
}

/** The options object of `app.openapi(createRoute({ ... }), handler)`. */
function routeConfig(
  index: ModuleIndex,
  node: Node | undefined,
): ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  const value = definition(index, node);
  const target = Node.isVariableDeclaration(value)
    ? value.getInitializer()
    : value;
  const call = target && unwrap(target);
  return Node.isCallExpression(call) &&
    /(?:^|\.)createRoute$/.test(call.getExpression().getText())
    ? objectLiteral(index, call.getArguments()[0])
    : objectLiteral(index, node);
}

function hasRequestBody(
  index: ModuleIndex,
  config: ObjectLiteralExpression,
): boolean {
  const request = propertyValue(config.getProperty("request"));
  if (!request) return false;
  const value = objectLiteral(index, request);
  // A request built elsewhere gets the benefit of the doubt.
  if (!value) return true;
  return (
    value.getProperty("body") !== undefined ||
    value.getProperties().some((property) => Node.isSpreadAssignment(property))
  );
}

/** `app.openapi(route, handler)` from @hono/zod-openapi. */
export function openapiRoute(
  index: ModuleIndex,
  args: Node[],
): RouteDeclaration | null {
  const config = routeConfig(index, args[0]);
  if (!config || !isHandler(args[1])) return null;
  const method = literalText(propertyValue(config.getProperty("method")));
  const path = literalText(propertyValue(config.getProperty("path")));
  if (method === null || path === null) return null;
  const middleware = propertyValue(config.getProperty("middleware"));
  const value = middleware && unwrap(middleware);
  const nodes = Node.isArrayLiteralExpression(value)
    ? value.getElements()
    : value
      ? [value]
      : [];
  return {
    methods: [method.toLowerCase()],
    // OpenAPI `{id}` parameters are registered as Hono `:id` parameters.
    path: path.replace(/\{([^}]+)\}/g, ":$1"),
    auth: protects(index, nodes).auth,
    validation: hasRequestBody(index, config),
  };
}
