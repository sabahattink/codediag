import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from "ts-morph";
import {
  definition,
  exportedValue,
  type FunctionLike,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  methodName,
  moduleOf,
  objectLiteral,
  propertyValue,
  resolveImport,
  unwrap,
} from "./fastify-plugins.js";
import { nodeId, type Protection } from "./hono-apps.js";
import {
  bodyRead,
  checksAuth,
  enclosingFunction,
  functionValue,
  middlewareAuthenticates,
  rejectsAnonymous,
  validatesInput,
} from "./react-router-handlers.js";
import {
  handlerSource,
  verifiesWebhookSignature,
} from "./webhook-signature.js";

/**
 * Resolves Elysia instances across a project and judges what runs before a
 * route: which expressions are an instance, which callbacks receive a group,
 * guard, or functional plugin instance, whether a hook or macro rejects
 * anonymous requests, and whether a route validates the body it reads.
 */

/** Which instances a hook applies to beyond its own (Elysia's `as`). */
export type Scope = "local" | "scoped" | "global";

/** Route registration methods; route(method, path, ...) names its method. */
export const ROUTE_METHODS = new Set([
  "all",
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);
/**
 * Instance methods that do not return the instance. Every other method call
 * on an instance is followed as a chain, so Elysia methods this list does
 * not name, such as propagate(), keep a chain intact.
 */
const NOT_CHAINABLE = new Set([
  "catch",
  "fetch",
  "finally",
  "handle",
  "stop",
  "then",
]);
/** Methods whose function argument receives an instance. */
const INSTANCE_CALLBACKS = new Set(["group", "guard", "use"]);
const ELYSIA_TYPE = /\bElysia\b/;
/** Calls that reject anonymous requests by their name: requireUser(), ensureAuth(). */
const REQUIRE_CALL =
  /^(?:require|ensure|assert|enforce)\w*(?:user|auth|login|session|role|admin|permission|account|member|access|signedin|loggedin)/i;
/** Hook properties of a macro, guard, or route options object. */
const AUTH_HOOKS = new Set(["beforeHandle", "resolve"]);
/** Bounds alias, import, and factory chains; real code needs a few hops. */
const MAX_RESOLUTION_DEPTH = 8;

export interface Instance {
  /** The instance: its `new Elysia()`, or the parameter that receives it. */
  context: string;
  /** The file that creates the instance. */
  home: string;
  /** `new Elysia({ prefix })`, added to the instance's own routes. */
  prefix: string;
}

/** Project files plus what a pre-pass learned about plugins and macros. */
export interface ElysiaIndex extends ModuleIndex {
  /**
   * Parameters that receive an instance: of functions passed to use(),
   * group(), or guard() by reference or from a factory, and of project
   * functions called with an instance, such as `registerRoutes(app)`.
   */
  readonly instanceParameters: ReadonlySet<Node>;
  /** Macros whose resolve or beforeHandle rejects anonymous requests. */
  readonly authMacros: ReadonlySet<string>;
}

/** Follows calls that return their receiver back to the instance expression. */
function chainRoot(node: Node): Node {
  let current = unwrap(node);
  while (Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      NOT_CHAINABLE.has(callee.getName())
    ) {
      break;
    }
    current = unwrap(callee.getExpression());
  }
  return current;
}

function homeOf(index: ModuleIndex, node: Node): string {
  return index.paths.get(node.getSourceFile()) ?? "";
}

/** A string a node holds: a literal, or a constant initialized with one. */
export function stringValue(
  index: ModuleIndex,
  node: Node | undefined,
): string | null {
  if (!node) return null;
  const value = unwrap(node);
  const literal = literalText(value);
  if (literal !== null) return literal;
  const declared = definition(index, value);
  const initializer = Node.isVariableDeclaration(declared)
    ? declared.getInitializer()
    : undefined;
  return initializer ? literalText(unwrap(initializer)) : null;
}

/** A path argument: its value, or `{expression}` when it is computed. */
export function pathText(index: ModuleIndex, node: Node | undefined): string {
  if (!node) return "";
  return stringValue(index, node) ?? `{${unwrap(node).getText()}}`;
}

function createsInstance(node: Node): boolean {
  return (
    Node.isNewExpression(node) && moduleOf(node.getExpression()) === "elysia"
  );
}

/** `new Elysia({ prefix: "/users" })`: the prefix option. */
function prefixOf(index: ModuleIndex, creation: Node): string {
  if (!Node.isNewExpression(creation)) return "";
  const options = objectLiteral(index, creation.getArguments()[0]);
  return (
    stringValue(index, propertyValue(options?.getProperty("prefix"))) ?? ""
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

/**
 * A parameter that receives an instance: the first parameter of a callback
 * passed to group(), guard(), or use() on an instance, one the pre-pass
 * found, or any parameter typed as Elysia.
 */
function receivesInstance(
  index: ElysiaIndex,
  parameter: Node,
  depth: number,
): boolean {
  if (!Node.isParameterDeclaration(parameter)) return false;
  if (ELYSIA_TYPE.test(parameter.getTypeNode()?.getText() ?? "")) return true;
  if (index.instanceParameters.has(parameter)) return true;
  const fn = parameter.getParent();
  if (!isFunctionLike(fn) || fn.getParameters()[0] !== parameter) return false;
  const call = fn.getParent();
  if (
    !Node.isCallExpression(call) ||
    !INSTANCE_CALLBACKS.has(methodName(call))
  ) {
    return false;
  }
  const callee = call.getExpression();
  return (
    Node.isPropertyAccessExpression(callee) &&
    instanceOf(index, callee.getExpression(), depth + 1) !== null
  );
}

function resolveInstance(
  index: ElysiaIndex,
  root: Node,
  depth: number,
): Instance | null {
  const value = definition(index, root);
  if (!value) return null;
  if (createsInstance(value)) {
    return {
      context: nodeId(index, value),
      home: homeOf(index, value),
      prefix: prefixOf(index, value),
    };
  }
  if (Node.isParameterDeclaration(value)) {
    return receivesInstance(index, value, depth)
      ? {
          context: nodeId(index, value),
          home: homeOf(index, value),
          prefix: "",
        }
      : null;
  }
  if (Node.isVariableDeclaration(value)) {
    const initializer = value.getInitializer();
    return initializer ? instanceOf(index, initializer, depth + 1) : null;
  }
  if (Node.isCallExpression(value)) {
    // An instance returned by a factory function in the project.
    const fn = functionValue(index, value.getExpression());
    if (!fn) return null;
    for (const returned of returnedValues(fn)) {
      const instance = instanceOf(index, returned, depth + 1);
      if (instance) return instance;
    }
  }
  return null;
}

/**
 * The instance an expression is, through method chains, variables, imports,
 * factories, and callback parameters. Only instances created with
 * `new Elysia()` or received as one count; names alone never do.
 */
export function instanceOf(
  index: ElysiaIndex,
  node: Node,
  depth = 0,
): Instance | null {
  if (depth > MAX_RESOLUTION_DEPTH) return null;
  return resolveInstance(index, chainRoot(node), depth);
}

/**
 * The function a plugin argument runs on the instance: inline, by reference,
 * or returned by a factory such as `use(rbac("admin"))`.
 */
export function pluginFunction(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): FunctionLike | undefined {
  if (!node || depth > MAX_RESOLUTION_DEPTH) return undefined;
  const direct = hookFunction(index, node);
  if (direct) return direct;
  const value = unwrap(node);
  if (!Node.isCallExpression(value)) return undefined;
  const factory = functionValue(index, value.getExpression());
  if (!factory) return undefined;
  for (const returned of returnedValues(factory)) {
    const fn = pluginFunction(index, returned, depth + 1);
    if (fn) return fn;
  }
  return undefined;
}

/** `use(import("./plugin"))`: the module's default export, if in the project. */
export function lazyPlugin(
  index: ModuleIndex,
  node: Node | undefined,
): Node | undefined {
  const value = node && unwrap(node);
  if (
    !Node.isCallExpression(value) ||
    value.getExpression().getKind() !== SyntaxKind.ImportKeyword
  ) {
    return undefined;
  }
  const specifier = literalText(value.getArguments()[0]);
  const target =
    specifier === null
      ? undefined
      : resolveImport(index, value.getSourceFile(), specifier);
  return target ? exportedValue(target, "default") : undefined;
}

/** The function a hook argument is, inline or by reference. */
function hookFunction(
  index: ModuleIndex,
  node: Node | undefined,
): FunctionLike | undefined {
  if (!node) return undefined;
  const value = unwrap(node);
  return isFunctionLike(value) ? value : functionValue(index, value);
}

function elements(node: Node | undefined): Node[] {
  if (!node) return [];
  const value = unwrap(node);
  return Node.isArrayLiteralExpression(value) ? value.getElements() : [value];
}

/** onBeforeHandle() and onRequest() functions that reject anonymous requests. */
export function hookAuthenticates(
  index: ModuleIndex,
  node: Node | undefined,
): boolean {
  return elements(node).some((element) =>
    middlewareAuthenticates(index, element),
  );
}

/** Calls `fn` makes when it runs, not in functions it defines, by name. */
function callsRequire(fn: Node): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    if (enclosingFunction(call) !== fn) return false;
    const callee = unwrap(call.getExpression());
    const name = Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : callee.getText();
    return REQUIRE_CALL.test(name);
  });
}

/**
 * derive() and resolve() functions that reject anonymous requests. Adding a
 * user to the context is not enough: `derive(() => ({ user }))` lets
 * anonymous requests through with `user` unset, and checks in the methods
 * a derive() returns run only when a handler calls them.
 */
export function contextAuthenticates(
  index: ModuleIndex,
  node: Node | undefined,
): boolean {
  const fn = hookFunction(index, node);
  return fn !== undefined && resolveRejects(fn);
}

function resolveRejects(fn: Node): boolean {
  return rejectsAnonymous(fn, true) || callsRequire(fn);
}

/** The name of an object member: `auth: { ... }`, `auth() { ... }`. */
function memberName(member: Node): string | null {
  if (
    Node.isPropertyAssignment(member) ||
    Node.isMethodDeclaration(member) ||
    Node.isShorthandPropertyAssignment(member)
  ) {
    return literalText(member.getNameNode()) ?? member.getName();
  }
  return null;
}

/** The function a hook member holds: `resolve: fn`, `resolve() { ... }`. */
function memberFunction(
  index: ModuleIndex,
  member: Node,
): FunctionLike | Node | undefined {
  if (Node.isMethodDeclaration(member)) return member;
  return hookFunction(index, propertyValue(member));
}

/**
 * Whether a macro definition rejects anonymous requests: a resolve or
 * beforeHandle member in it (or in the object its function returns), or a
 * beforeHandle registered through the older `onBeforeHandle(fn)` argument.
 */
function macroAuthenticates(index: ModuleIndex, value: Node): boolean {
  const nodes = [value, ...value.getDescendants()];
  return nodes.some((node) => {
    const name = memberName(node);
    if (name !== null && AUTH_HOOKS.has(name)) {
      const fn = memberFunction(index, node);
      if (!fn) return false;
      return name === "resolve"
        ? resolveRejects(fn)
        : checksAuth(index, fn).auth;
    }
    if (!Node.isCallExpression(node)) return false;
    const callee = node.getExpression();
    return (
      Node.isIdentifier(callee) &&
      /^on(?:BeforeHandle|Resolve)$/.test(callee.getText()) &&
      node.getArguments().some((argument) => {
        const fn = hookFunction(index, argument);
        return fn !== undefined && checksAuth(index, fn).auth;
      })
    );
  });
}

/** The members of an object, resolving a function to the object it returns. */
function macroMembers(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): Node[] {
  if (!node || depth > MAX_RESOLUTION_DEPTH) return [];
  const literal = objectLiteral(index, node);
  if (literal) return literal.getProperties();
  const fn = hookFunction(index, node);
  return fn
    ? returnedValues(fn).flatMap((value) =>
        macroMembers(index, value, depth + 1),
      )
    : [];
}

/** Auth macros a macro() call defines, by the option name that enables them. */
export function authMacros(index: ModuleIndex, call: CallExpression): string[] {
  const [first, second] = call.getArguments();
  const named = stringValue(index, first);
  if (named !== null) {
    return second && macroAuthenticates(index, second) ? [named] : [];
  }
  return macroMembers(index, first).flatMap((member) => {
    const name = memberName(member);
    return name !== null && macroAuthenticates(index, member) ? [name] : [];
  });
}

export interface HookOptions extends Protection {
  scope: Scope;
}

function scopeOf(index: ModuleIndex, node: Node | undefined): Scope {
  const value = stringValue(index, node);
  if (value === "global") return "global";
  // "plugin" is the name Elysia 1.0 gave the scoped cast.
  return value === "scoped" || value === "plugin" ? "scoped" : "local";
}

/** A macro option that is set: anything but `false` or `undefined`. */
function enables(node: Node | undefined): boolean {
  return node !== undefined && !/^(?:false|undefined)$/.test(node.getText());
}

/**
 * What a hook object protects: the options of a route, guard(), or group().
 * beforeHandle, a rejecting resolve, and auth macros authenticate; a body
 * schema validates. An object this scan cannot read gets the benefit of the
 * doubt for validation.
 */
export function hookOptions(
  index: ElysiaIndex,
  node: Node | undefined,
): HookOptions {
  if (!node) return { auth: false, validation: false, scope: "local" };
  const literal: ObjectLiteralExpression | undefined = objectLiteral(
    index,
    node,
  );
  if (!literal) return { auth: false, validation: true, scope: "local" };
  const value = (name: string) => propertyValue(literal.getProperty(name));
  const auth =
    hookAuthenticates(index, value("beforeHandle")) ||
    elements(value("resolve")).some((fn) => contextAuthenticates(index, fn)) ||
    literal.getProperties().some((property) => {
      const name = memberName(property);
      return (
        name !== null &&
        index.authMacros.has(name) &&
        enables(propertyValue(property))
      );
    });
  const validation =
    literal.getProperty("body") !== undefined ||
    literal
      .getProperties()
      .some((property) => Node.isSpreadAssignment(property));
  return { auth, validation, scope: scopeOf(index, value("as")) };
}

/** `onBeforeHandle({ as: "scoped" }, fn)`: the options and the functions. */
export function hookArguments(
  index: ElysiaIndex,
  args: Node[],
): { scope: Scope; functions: Node[] } {
  const [first, ...rest] = args;
  const options = first && unwrap(first);
  if (Node.isObjectLiteralExpression(options)) {
    return {
      scope: scopeOf(index, propertyValue(options.getProperty("as"))),
      functions: rest,
    };
  }
  return { scope: "local", functions: args };
}

/**
 * Whether a handler reads the request body: a `body` binding of its context,
 * `ctx.body`, `request.json()`, or a context passed on whole. A handler this
 * scan cannot read is assumed to.
 */
function readsBody(fn: FunctionLike | undefined): boolean {
  if (!fn) return true;
  if (bodyRead(fn)) return true;
  const [context] = fn.getParameters();
  if (!context) return false;
  const name = context.getNameNode();
  if (Node.isObjectBindingPattern(name)) {
    return name
      .getElements()
      .some(
        (element) =>
          element.getDotDotDotToken() !== undefined ||
          (element.getPropertyNameNode()?.getText() ?? element.getName()) ===
            "body",
      );
  }
  if (!Node.isIdentifier(name)) return true;
  const contextName = name.getText();
  return fn.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => {
    if (identifier === name || identifier.getText() !== contextName) {
      return false;
    }
    const parent = identifier.getParent();
    if (!Node.isPropertyAccessExpression(parent)) return true;
    return parent.getExpression() === identifier && parent.getName() === "body";
  });
}

export interface HandlerCheck extends Protection {
  readsBody: boolean;
}

/**
 * What a route handler does itself: rejects anonymous requests (in its code
 * or a project function it calls), verifies a webhook signature, reads the
 * body, and parses it with a schema.
 */
export function handlerCheck(
  index: ModuleIndex,
  node: Node | undefined,
): HandlerCheck {
  const fn = hookFunction(index, node);
  const signed =
    node !== undefined && verifiesWebhookSignature(handlerSource(node));
  return {
    auth: signed || (fn !== undefined && checksAuth(index, fn).auth),
    validation: fn !== undefined && validatesInput(index, fn),
    readsBody: readsBody(fn),
  };
}
