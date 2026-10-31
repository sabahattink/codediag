import {
  type CallExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  importSource,
  literalText,
  methodName,
  moduleOf,
  propertyValue,
  receiverOf,
  unwrap,
} from "./fastify-plugins.js";
import { type FunctionLike, returnedValues } from "./taint-graph.js";

/**
 * Checks on single tRPC nodes, without following other files: what an import
 * is, whether a middleware function authenticates, whether a parser function
 * only casts, and whether an errorFormatter returns a stack trace.
 */

export const TRPC_SERVER = "@trpc/server";
/** Packages whose handlers serve a tRPC router over HTTP. */
const ADAPTER_MODULE = /^@trpc\/server\/adapters\/|^@hono\/trpc-server$/;
const AUTH_ERROR_CODES = new Set(["FORBIDDEN", "UNAUTHORIZED"]);
/** Names and code that suggest an auth check, as the other analyzers use. */
export const AUTH_NAMES =
  /auth|permission|permit|protect|require.*(?:user|role|login)|jwt|bearer|api[-_]?key|admin/i;
/** The caller's identity on the tRPC context: `ctx.session`, `ctx.user`. */
const IDENTITY = /\bctx\??\.\s*(?:auth|session|user|userId|viewer)\b/;
/** The error a formatter receives, or its cause. */
const ERROR_VALUE = /(?:^|\.)(?:cause|err|error)$/;

/** The `@trpc/server` export an identifier or `trpc.name` refers to. */
export function trpcExport(node: Node): string | null {
  if (Node.isPropertyAccessExpression(node)) {
    return moduleOf(node.getExpression()) === TRPC_SERVER
      ? node.getName()
      : null;
  }
  if (!Node.isIdentifier(node)) return null;
  const declaration = node.getSymbol()?.getDeclarations()[0];
  const source = declaration ? importSource(declaration) : null;
  return source?.specifier === TRPC_SERVER ? source.name : null;
}

/** `initTRPC.create()`, also after `.context<Context>()` and `.meta<Meta>()`. */
export function isCreateCall(call: CallExpression): boolean {
  if (methodName(call) !== "create") return false;
  let current = unwrap(receiverOf(call));
  while (
    Node.isCallExpression(current) &&
    ["context", "meta"].includes(methodName(current))
  ) {
    current = unwrap(receiverOf(current));
  }
  return trpcExport(current) === "initTRPC";
}

/** The property a destructured binding reads: `procedure` in `{ procedure: p }`. */
export function bindingKey(node: Node): string | null {
  if (!Node.isBindingElement(node)) return null;
  return node.getPropertyNameNode()?.getText() ?? node.getName();
}

/** The initializer a destructured binding reads from: `t` in `const { procedure } = t`. */
export function bindingSource(node: Node): Node | undefined {
  return node
    .getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    ?.getInitializer();
}

/** `throw new TRPCError({ code: "UNAUTHORIZED" })` or FORBIDDEN anywhere in a node. */
export function throwsAuthError(fn: Node): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.NewExpression).some((created) => {
    if (!/(?:^|\.)TRPCError$/.test(created.getExpression().getText())) {
      return false;
    }
    const [options] = created.getArguments();
    const code = Node.isObjectLiteralExpression(options)
      ? propertyValue(options.getProperty("code"))
      : undefined;
    return AUTH_ERROR_CODES.has(literalText(code) ?? "");
  });
}

/** `if (!ctx.session?.user) throw ...`: rejects callers without an identity. */
function guardsIdentity(fn: Node): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.IfStatement).some((statement) => {
    const then = statement.getThenStatement();
    return (
      IDENTITY.test(statement.getExpression().getText()) &&
      (Node.isThrowStatement(then) ||
        then.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0)
    );
  });
}

/**
 * True when a middleware function authenticates: it throws TRPCError
 * UNAUTHORIZED or FORBIDDEN, throws when the context has no caller identity,
 * or reads like an auth check (`requireUser(ctx)`).
 */
export function authenticates(fn: Node): boolean {
  return (
    throwsAuthError(fn) || guardsIdentity(fn) || AUTH_NAMES.test(fn.getText())
  );
}

/** `(value) => value as Input`: a parser that casts instead of checking. */
export function returnsArgument(fn: FunctionLike): boolean {
  const name = fn.getParameters()[0]?.getNameNode();
  if (!name || !Node.isIdentifier(name)) return false;
  const body = fn.getBody();
  if (!body) return false;
  // A block may only return: any other statement could be a check.
  if (Node.isBlock(body)) {
    const statements = body.getStatements();
    if (statements.length !== 1 || !Node.isReturnStatement(statements[0])) {
      return false;
    }
  }
  const results = returnedValues(fn);
  return (
    results.length > 0 &&
    results.every((result) => {
      const value = unwrap(result);
      return Node.isIdentifier(value) && value.getText() === name.getText();
    })
  );
}

/** True when a node is evaluated only under a condition or passed to a call. */
function isGuarded(node: Node, root: Node): boolean {
  let current = node;
  while (current !== root) {
    const parent = current.getParent();
    if (!parent) return false;
    if (
      (Node.isConditionalExpression(parent) &&
        parent.getCondition() !== current) ||
      (Node.isBinaryExpression(parent) &&
        parent.getOperatorToken().getKind() ===
          SyntaxKind.AmpersandAmpersandToken &&
        parent.getRight() === current) ||
      (Node.isCallExpression(parent) && parent.getArguments().includes(current))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

/** `error.stack` in what an errorFormatter returns, outside any condition. */
export function leakedStack(fn: FunctionLike): Node | undefined {
  for (const value of returnedValues(fn)) {
    // A return inside `if (isDev)` or a switch case is conditional too.
    const branch = value.getFirstAncestor(
      (ancestor) =>
        ancestor === fn ||
        Node.isIfStatement(ancestor) ||
        Node.isCaseClause(ancestor),
    );
    if (branch !== fn) continue;
    const access = [
      value,
      ...value.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ].find(
      (node) =>
        Node.isPropertyAccessExpression(node) &&
        node.getName() === "stack" &&
        ERROR_VALUE.test(node.getExpression().getText()) &&
        !isGuarded(node, value),
    );
    if (access) return access;
  }
  return undefined;
}

/**
 * trpc-sveltekit's handle hook serves a router; its client comes from the
 * same package, so only this export makes a file an adapter.
 */
export const SVELTEKIT_ADAPTER = {
  specifier: "trpc-sveltekit",
  name: "createTRPCHandle",
} as const;

/** A file that imports a tRPC adapter (`@trpc/server/adapters/fetch`). */
export function importsTrpcAdapter(sourceFile: SourceFile): boolean {
  if (
    !/@trpc\/server\/adapters\/|@hono\/trpc-server|trpc-sveltekit/.test(
      sourceFile.getFullText(),
    )
  ) {
    return false;
  }
  return (
    sourceFile
      .getImportDeclarations()
      .some(
        (declaration) =>
          declaration.getModuleSpecifierValue() ===
            SVELTEKIT_ADAPTER.specifier &&
          declaration
            .getNamedImports()
            .some((named) => named.getName() === SVELTEKIT_ADAPTER.name),
      ) ||
    sourceFile
      .getImportDeclarations()
      .some((declaration) =>
        ADAPTER_MODULE.test(declaration.getModuleSpecifierValue()),
      ) ||
    sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .some(
        (call) =>
          call.getExpression().getText() === "require" &&
          ADAPTER_MODULE.test(literalText(call.getArguments()[0]) ?? ""),
      )
  );
}

/** Where a property or binding holding a procedure is named. */
export function localName(call: CallExpression): string {
  const holder = call.getParentWhile(
    (parent) =>
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent),
  );
  const parent = (holder ?? call).getParent();
  return Node.isPropertyAssignment(parent) || Node.isVariableDeclaration(parent)
    ? parent.getName()
    : "(unnamed)";
}
