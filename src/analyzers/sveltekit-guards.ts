import { type CallExpression, Node, SyntaxKind } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import {
  definition,
  importSource,
  isFunctionLike,
  type ModuleIndex,
  resolveImport,
  unwrap,
} from "./fastify-plugins.js";
import {
  type Condition,
  conditionsOf,
  kitExport,
  normalized,
  reachable,
  type Strength,
  strongestIdentity,
} from "./sveltekit-conditions.js";
import {
  exportedNode,
  type KitConfig,
  type Route,
  serverHooksFile,
} from "./sveltekit-routes.js";
import { returnedValues } from "./taint-graph.js";

/**
 * Where a SvelteKit request is rejected for an anonymous caller: in the
 * handle hook of src/hooks.server.ts for the routes it guards, or in the
 * handler itself, directly or through project helpers. A hook that only
 * populates `event.locals` guards nothing.
 */

/** Bounds the project functions followed from a handler, as trpc-perimeter.ts does. */
const MAX_HELPER_DEPTH = 2;
const MAX_HANDLE_DEPTH = 6;
const AUTH_STATUS = new Set([401, 403]);
const SIGN_IN_PATH = /log-?in|sign-?in|auth/i;
const AUTH_MESSAGE =
  /\bunauthori[sz]ed\b|\bforbidden\b|\bnot (?:logged|signed) in\b|\bnot authenticated\b|\bauthentication required\b|\bplease (?:sign|log) ?in\b|\b(?:sign|log) ?in (?:first|required|to)\b|\binvalid (?:token|signature|secret|api key)\b|\bmissing (?:session|token)\b/i;
/** Unresolved helpers named like an auth check: `requireUser`, `assertAdmin`. */
const AUTH_HELPER =
  /^(?:require|assert|ensure|check|verify|guard|protect|authorize|authenticate)\w*(?:auth|user|session|login|admin|role|permission|signedin|loggedin|access)\w*$|^(?:with|require)Auth\w*$|^authori[sz]e$|^authenticate$|^\w*(?:User|Session|Auth|Viewer)\w*Or(?:Throw|Fail|Redirect|Error)$/i;
/** Webhook signature checks, which authenticate the sender. */
const SIGNATURE_CHECK =
  /^(?:constructEvent(?:Async)?|verify(?:Webhook|Signature|Request)\w*|validate(?:Webhook|Signature)\w*|timingSafeEqual)$/;
const WEBHOOK_RECEIVER = /webhook|\bwh$|signature|hmac/i;
/** Packages whose handle hooks only populate locals or serve other routes. */
const NON_GUARD_PACKAGE =
  /^(?:@auth\/sveltekit|@sentry\/sveltekit|trpc-sveltekit|@inlang\/|@clerk\/sveltekit|svelte-kit-cookie-session|@supabase\/|@sveltejs\/kit|@opentelemetry\/|svelte-i18n)/;
/** Specifiers of project modules, as opposed to packages and $app/$env. */
const PROJECT_SPECIFIER = /^(?:\.|\$lib(?:\/|$)|#|~\/|@\/|src\/)/;
/** Methods that hand a whole request to another router: `app.fetch(request)`. */
const DELEGATE_METHOD = /^(?:fetch|handle|handler|request|dispatch|serve)$/;

interface Stop {
  node: Node;
  /** The response tells the caller to authenticate: 401, 403, a sign-in redirect. */
  authenticates: boolean;
  /** A throw or redirect, which a name-only identity check counts with in helpers. */
  throws: boolean;
  /** A project helper whose own checks decide whether this call is a guard. */
  helper?: Node;
}

interface Site extends Stop {
  conditions: Condition[];
  identity: Strength | null;
}

export interface Perimeter {
  file: string | null;
  handles: Node[];
  /** Part of the handle could not be read, so findings are less certain. */
  opaque: boolean;
}

function statusOf(node: Node | undefined): number | null {
  const value = node && unwrap(node);
  return Node.isNumericLiteral(value) ? Number(value.getLiteralValue()) : null;
}

/** Whether a rejection says the caller must authenticate. */
function signalsAuth(node: Node): boolean {
  for (const part of [node, ...node.getDescendants()]) {
    if (Node.isCallExpression(part)) {
      const kit = kitExport(part.getExpression());
      const [first, second] = part.getArguments();
      if ((kit === "error" || kit === "fail") && first) {
        if (AUTH_STATUS.has(statusOf(first) ?? 0)) return true;
      }
      if (kit === "redirect" && second && SIGN_IN_PATH.test(second.getText())) {
        return true;
      }
      // Response.redirect('/login', 302)
      if (
        /(?:^|\.)Response\.redirect$/.test(part.getExpression().getText()) &&
        first &&
        SIGN_IN_PATH.test(first.getText())
      ) {
        return true;
      }
    } else if (Node.isPropertyAssignment(part)) {
      const name = part.getName().replace(/["']/g, "").toLowerCase();
      const value = part.getInitializer();
      if (name === "status" && AUTH_STATUS.has(statusOf(value) ?? 0)) {
        return true;
      }
      // new Response(null, { status: 303, headers: { location: '/login' } })
      if (name === "location" && value && SIGN_IN_PATH.test(value.getText())) {
        return true;
      }
    } else if (
      (Node.isStringLiteral(part) ||
        Node.isNoSubstitutionTemplateLiteral(part)) &&
      AUTH_MESSAGE.test(part.getLiteralText())
    ) {
      return true;
    }
  }
  return false;
}

function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : callee.getText();
}

function isSignatureCheck(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (SIGNATURE_CHECK.test(calleeName(call))) return true;
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "verify" &&
    WEBHOOK_RECEIVER.test(callee.getExpression().getText())
  );
}

/** The function a callee holds, through variables and imports. */
export function functionValue(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): Node | undefined {
  if (!node || depth > MAX_HANDLE_DEPTH) return undefined;
  const value = definition(index, node);
  if (isFunctionLike(value) || Node.isMethodDeclaration(value)) return value;
  if (Node.isVariableDeclaration(value)) {
    const initializer = value.getInitializer();
    return initializer && functionValue(index, unwrap(initializer), depth + 1);
  }
  return undefined;
}

function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (ancestor) =>
      isFunctionLike(ancestor) || Node.isMethodDeclaration(ancestor),
  );
}

/** A hook return that hands the request on: `return resolve(event)`. */
function passesThrough(value: Node): boolean {
  const target = unwrap(value);
  if (/\bresolve\s*\(/.test(target.getText())) return true;
  if (!Node.isIdentifier(target)) return false;
  const declaration = target.getSymbol()?.getDeclarations()[0];
  return (
    Node.isVariableDeclaration(declaration) &&
    /\bresolve\s*\(/.test(declaration.getInitializer()?.getText() ?? "")
  );
}

export class Guards {
  private readonly results = new Map<Node, Map<string, boolean>>();
  private readonly siteCache = new Map<Node, Map<string, Site[]>>();

  constructor(private readonly index: ModuleIndex) {}

  /**
   * Points where a function stops the request, with the conditions they run
   * under. They do not depend on the route, so a hook is read once.
   */
  private sites(fn: Node, kind: "hook" | "handler", depth: number): Site[] {
    const key = `${kind}:${depth}`;
    const cached = this.siteCache.get(fn)?.get(key);
    if (cached) return cached;
    const sites = fn.getDescendants().flatMap((node): Site[] => {
      const stop = this.stopAt(fn, node, kind, depth);
      if (!stop) return [];
      const conditions = conditionsOf(stop.node, fn);
      return [
        {
          ...stop,
          conditions,
          identity: strongestIdentity(this.index, conditions),
        },
      ];
    });
    const entries = this.siteCache.get(fn) ?? new Map<string, Site[]>();
    entries.set(key, sites);
    this.siteCache.set(fn, entries);
    return sites;
  }

  private stopAt(
    fn: Node,
    node: Node,
    kind: "hook" | "handler",
    depth: number,
  ): Stop | null {
    if (Node.isThrowStatement(node)) {
      return { node, authenticates: signalsAuth(node), throws: true };
    }
    if (Node.isReturnStatement(node)) {
      const value = node.getExpression();
      if (enclosingFunction(node) !== fn) return null;
      if (kind === "hook" && (!value || passesThrough(value))) return null;
      return {
        node,
        authenticates: value ? signalsAuth(value) : false,
        throws: false,
      };
    }
    return Node.isCallExpression(node) ? this.callStop(fn, node, depth) : null;
  }

  private callStop(fn: Node, call: CallExpression, depth: number): Stop | null {
    const kit = kitExport(call.getExpression());
    if (kit === "redirect" || kit === "error") {
      return { node: call, authenticates: signalsAuth(call), throws: true };
    }
    if (isSignatureCheck(call)) {
      return { node: call, authenticates: true, throws: true };
    }
    if (depth >= MAX_HELPER_DEPTH) return null;
    const helper = functionValue(this.index, call.getExpression());
    if (helper && helper !== fn) {
      return { node: call, authenticates: true, throws: true, helper };
    }
    return !helper && AUTH_HELPER.test(calleeName(call))
      ? { node: call, authenticates: true, throws: true }
      : null;
  }

  /**
   * Whether a function rejects an anonymous request to the route: a stop
   * reachable for it that answers 401 or 403, redirects to sign-in, or is
   * guarded by a check of `locals`, the session cookie, or an auth header.
   * A check known only by name counts in the handler or hook itself, and in
   * a helper only when it throws, since helpers often return early for
   * values that merely happen to be called `user`.
   */
  guards(
    fn: Node,
    kind: "hook" | "handler",
    route: Route | null,
    depth = 0,
  ): boolean {
    const key = `${kind}:${depth}:${route?.id ?? ""}`;
    const cached = this.results.get(fn)?.get(key);
    if (cached !== undefined) return cached;
    const entries = this.results.get(fn) ?? new Map<string, boolean>();
    this.results.set(fn, entries);
    // A helper that calls itself is not a guard on that path.
    entries.set(key, false);
    const result = this.sites(fn, kind, depth).some((site) => {
      if (!reachable(this.index, route, site.conditions)) return false;
      if (site.helper) {
        return this.guards(site.helper, "handler", route, depth + 1);
      }
      if (site.authenticates || site.identity === "strong") return true;
      return site.identity === "weak" && (site.throws || depth === 0);
    });
    entries.set(key, result);
    return result;
  }

  /** Whether a handler, or a wrapper around it, rejects anonymous callers. */
  handlerGuards(
    fn: Node | undefined,
    wrappers: readonly CallExpression[],
    route: Route,
  ): boolean {
    return (
      wrappers.some((wrapper) => {
        const helper = functionValue(this.index, wrapper.getExpression());
        return helper
          ? this.guards(helper, "handler", route, 1)
          : AUTH_HELPER.test(calleeName(wrapper));
      }) ||
      (fn !== undefined && this.guards(fn, "handler", route))
    );
  }
}

/** A call to a project module the scan could not resolve. */
export function isOpaqueCall(
  index: ModuleIndex,
  call: CallExpression,
): boolean {
  let root: Node = call.getExpression();
  while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
  if (!Node.isIdentifier(root)) return false;
  const declaration = root.getSymbol()?.getDeclarations()[0];
  const source = declaration ? importSource(declaration) : null;
  return (
    source !== null &&
    PROJECT_SPECIFIER.test(source.specifier) &&
    definition(index, root) === undefined
  );
}

/** Whether code calls project helpers the scan could not read. */
export function hasOpaqueCalls(
  index: ModuleIndex,
  nodes: readonly Node[],
): boolean {
  return nodes.some((node) =>
    [node, ...node.getDescendantsOfKind(SyntaxKind.CallExpression)].some(
      (call) => Node.isCallExpression(call) && isOpaqueCall(index, call),
    ),
  );
}

/** A handler that hands the whole request to another router or upstream. */
export function delegates(fn: Node): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      DELEGATE_METHOD.test(callee.getName()) &&
      call
        .getArguments()
        .some((argument) =>
          /^(?:event|request|event\.request)$/.test(normalized(argument)),
        )
    );
  });
}

interface HandleParts {
  functions: Node[];
  opaque: boolean;
}

function importedFrom(node: Node): string | null {
  let root = unwrap(node);
  while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
  if (!Node.isIdentifier(root)) return null;
  const declaration = root.getSymbol()?.getDeclarations()[0];
  return declaration ? (importSource(declaration)?.specifier ?? null) : null;
}

/** A handle from a package: it guards nothing, unless it is unknown. */
function packageHandle(specifier: string | null): HandleParts | null {
  if (specifier === null || PROJECT_SPECIFIER.test(specifier)) return null;
  return { functions: [], opaque: !NON_GUARD_PACKAGE.test(specifier) };
}

function merge(parts: HandleParts[]): HandleParts {
  return {
    functions: parts.flatMap((part) => part.functions),
    opaque: parts.some((part) => part.opaque),
  };
}

/** The handle functions an expression stands for, through sequence() and factories. */
function handleParts(
  index: ModuleIndex,
  node: Node | undefined,
  depth = 0,
): HandleParts {
  if (!node || depth > MAX_HANDLE_DEPTH) return { functions: [], opaque: true };
  const initializer = Node.isVariableDeclaration(node)
    ? node.getInitializer()
    : node;
  const value = initializer && unwrap(initializer);
  if (!value) return { functions: [], opaque: true };
  if (isFunctionLike(value)) return { functions: [value], opaque: false };
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
    if (/(?:^|\.)sequence$/.test(callee.getText())) {
      return merge(
        value.getArguments().map((arg) => handleParts(index, arg, depth + 1)),
      );
    }
    const fromPackage = packageHandle(importedFrom(callee));
    if (fromPackage) return fromPackage;
    const factory = functionValue(index, callee);
    if (!isFunctionLike(factory)) return { functions: [], opaque: true };
    return merge(
      returnedValues(factory).map((returned) =>
        handleParts(index, returned, depth + 1),
      ),
    );
  }
  if (Node.isBindingElement(value)) {
    // export const { handle } = SvelteKitAuth({ ... })
    const source = value.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const initializer = source?.getInitializer();
    const call = initializer && unwrap(initializer);
    return (
      (Node.isCallExpression(call) &&
        packageHandle(importedFrom(call.getExpression()))) || {
        functions: [],
        opaque: true,
      }
    );
  }
  const resolved = definition(index, value) ?? importedExport(index, value);
  if (resolved === undefined) {
    return (
      packageHandle(importedFrom(value)) ?? { functions: [], opaque: true }
    );
  }
  return resolved === value
    ? { functions: [], opaque: true }
    : handleParts(index, resolved, depth + 1);
}

/**
 * An import of a project file's export that definition() cannot follow, such
 * as `export const { handle } = SvelteKitAuth(...)` in src/auth.ts.
 */
function importedExport(index: ModuleIndex, node: Node): Node | undefined {
  if (!Node.isIdentifier(node)) return undefined;
  const declaration = node.getSymbol()?.getDeclarations()[0];
  const source = declaration ? importSource(declaration) : null;
  const target =
    source && PROJECT_SPECIFIER.test(source.specifier)
      ? resolveImport(index, node.getSourceFile(), source.specifier)
      : undefined;
  return target && exportedNode(index, target, source?.name ?? "");
}

/** The handle hook of src/hooks.server.ts, split into its sequenced parts. */
export function serverPerimeter(
  context: ScanContext,
  index: ModuleIndex,
  config: KitConfig,
): Perimeter {
  const file = serverHooksFile(context, config);
  const sourceFile = file ? index.files.get(file) : undefined;
  if (!file || !sourceFile) return { file: null, handles: [], opaque: false };
  const exported = exportedNode(index, sourceFile, "handle");
  if (!exported) return { file, handles: [], opaque: false };
  const parts = handleParts(index, exported);
  return {
    file,
    handles: parts.functions,
    opaque: parts.opaque || hasOpaqueCalls(index, parts.functions),
  };
}
