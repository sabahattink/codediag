import { type CallExpression, Node, SyntaxKind } from "ts-morph";
import { type ModuleIndex, moduleOf, unwrap } from "./fastify-plugins.js";
import { conditionsOf, kitExport, normalized } from "./sveltekit-conditions.js";
import { functionValue, isOpaqueCall } from "./sveltekit-guards.js";

/**
 * Whether a SvelteKit handler validates the request body it reads: a schema
 * parses the body (Zod, Valibot, Yup, Superforms, ArkType, TypeBox, ...), or
 * the handler answers 400 or 422 when a body value fails a check, as the
 * SvelteKit form actions documentation shows with fail(400).
 */

export interface BodyCheck {
  /** The handler reads `request.json()` or `request.formData()`. */
  reads: boolean;
  validated: boolean;
  /** The body reaches a project helper the scan could not read. */
  opaque: boolean;
}

/** Bounds the project functions followed with the body, like the auth checks. */
const MAX_HELPER_DEPTH = 2;
const BODY_READ = /^(?:json|formData)$/;
const REQUEST = /(?:^|\.)request(?:\.clone\(\))?$/;
/** Method and function names that check a value against a schema. */
const SCHEMA_CALL =
  /^(?:parse|safeParse|parseAsync|safeParseAsync|spa|validate|validateSync|validateAsync|isValid|isValidSync|Check|Parse|Decode|decodeUnknown\w*|superValidate)$/;
/** Receivers whose parse() turns text into data without checking it. */
const NOT_A_SCHEMA =
  /^(?:JSON|Date|URL|Number|BigInt|qs|querystring|devalue|cookie|path|superjson|YAML|yaml|toml|Papa)$/;
const VALIDATION_PACKAGE =
  /^(?:zod(?:\/|$)|valibot|yup|joi|superstruct|arktype|@sinclair\/typebox|typebox|ajv|sveltekit-superforms|zod-form-data|effect|@effect\/schema|io-ts|runtypes|@vinejs\/vine|class-validator|@badrap\/valita)/;
/** Unresolved helpers named like a validator: `validatePost`, `parseForm`. */
const VALIDATION_NAME =
  /valid|schema|sanitize|zod|joi|yup|ajv|parse(?:Form|Body|Input|Request)|check(?:Body|Input|Form)/i;
const INVALID_STATUS = new Set([400, 422]);

function isBodyRead(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  return (
    Node.isPropertyAccessExpression(callee) &&
    BODY_READ.test(callee.getName()) &&
    REQUEST.test(normalized(callee.getExpression()))
  );
}

function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : callee.getText();
}

function isSchemaCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (
    Node.isPropertyAccessExpression(callee) &&
    NOT_A_SCHEMA.test(normalized(callee.getExpression()))
  ) {
    return false;
  }
  if (SCHEMA_CALL.test(calleeName(call))) return true;
  let root: Node = callee;
  while (Node.isPropertyAccessExpression(root) || Node.isCallExpression(root)) {
    root = root.getExpression();
  }
  return VALIDATION_PACKAGE.test(moduleOf(root) ?? "");
}

function boundNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return name
      .getElements()
      .flatMap((element) =>
        Node.isBindingElement(element) ? boundNames(element.getNameNode()) : [],
      );
  }
  return [];
}

/** An identifier that refers to a variable, not a property name. */
function isReference(identifier: Node): boolean {
  const parent = identifier.getParent();
  return !(
    (Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === identifier) ||
    (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier)
  );
}

/** Whether a node reads the body or a variable holding part of it. */
function usesBody(node: Node, names: ReadonlySet<string>): boolean {
  return [node, ...node.getDescendants()].some(
    (part) =>
      isBodyRead(part) ||
      (Node.isIdentifier(part) &&
        names.has(part.getText()) &&
        isReference(part)),
  );
}

/** Variables that hold the body or values taken from it. */
function bodyNames(fn: Node): Set<string> {
  const names = new Set<string>();
  const declarations = fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const loop = declaration.getParent()?.getParent();
      const source = Node.isForOfStatement(loop)
        ? loop.getExpression()
        : declaration.getInitializer();
      if (!source || !usesBody(source, names)) continue;
      for (const name of boundNames(declaration.getNameNode())) {
        if (names.has(name)) continue;
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

function statusOf(node: Node | undefined): number | null {
  const value = node && unwrap(node);
  return Node.isNumericLiteral(value) ? Number(value.getLiteralValue()) : null;
}

/** `fail(400)`, `error(422)`, or a response with `status: 400`. */
function rejectsInvalid(node: Node): boolean {
  if (Node.isCallExpression(node)) {
    const kit = kitExport(node.getExpression());
    return (
      (kit === "fail" || kit === "error") &&
      INVALID_STATUS.has(statusOf(node.getArguments()[0]) ?? 0)
    );
  }
  return (
    Node.isPropertyAssignment(node) &&
    node.getName() === "status" &&
    INVALID_STATUS.has(statusOf(node.getInitializer()) ?? 0)
  );
}

/** A 400 or 422 answer under a condition on the body: `if (!title) fail(400)`. */
function checksManually(fn: Node, names: ReadonlySet<string> | null): boolean {
  return fn
    .getDescendants()
    .filter(rejectsInvalid)
    .some((site) =>
      conditionsOf(site, fn).some(
        (condition) => names === null || usesBody(condition.node, names),
      ),
    );
}

export class BodyValidation {
  private readonly cache = new Map<Node, boolean>();

  constructor(private readonly index: ModuleIndex) {}

  /** Whether a helper receiving the body validates what it is given. */
  private helperValidates(fn: Node, depth: number): boolean {
    const cached = this.cache.get(fn);
    if (cached !== undefined) return cached;
    this.cache.set(fn, false);
    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    const result =
      calls.some(isSchemaCall) ||
      checksManually(fn, null) ||
      (depth < MAX_HELPER_DEPTH &&
        calls.some((call) => {
          const helper = functionValue(this.index, call.getExpression());
          return (
            helper !== undefined && this.helperValidates(helper, depth + 1)
          );
        }));
    this.cache.set(fn, result);
    return result;
  }

  private callValidates(call: CallExpression, names: ReadonlySet<string>) {
    if (!call.getArguments().some((argument) => usesBody(argument, names))) {
      return { validated: false, opaque: false };
    }
    if (isSchemaCall(call)) return { validated: true, opaque: false };
    const helper = functionValue(this.index, call.getExpression());
    if (helper) {
      return { validated: this.helperValidates(helper, 1), opaque: false };
    }
    return {
      validated: VALIDATION_NAME.test(calleeName(call)),
      opaque: isOpaqueCall(this.index, call),
    };
  }

  check(fn: Node | undefined, wrappers: readonly CallExpression[]): BodyCheck {
    if (!fn) return { reads: false, validated: true, opaque: false };
    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    const superforms = calls.some(
      (call) => calleeName(call) === "superValidate",
    );
    const reads = superforms || calls.some(isBodyRead);
    if (!reads) return { reads, validated: true, opaque: false };
    const wrapped = wrappers.some((wrapper) => {
      const helper = functionValue(this.index, wrapper.getExpression());
      return helper
        ? this.helperValidates(helper, 1)
        : VALIDATION_NAME.test(calleeName(wrapper));
    });
    const names = bodyNames(fn);
    const verdicts = calls.map((call) => this.callValidates(call, names));
    // ArkType schemas are called directly and checked with `instanceof type.errors`.
    const arktype = /instanceof\s+(?:type\.errors|ArkErrors)\b/.test(
      fn.getText(),
    );
    return {
      reads,
      validated:
        superforms ||
        wrapped ||
        arktype ||
        verdicts.some((verdict) => verdict.validated) ||
        checksManually(fn, names),
      opaque: verdicts.some((verdict) => verdict.opaque),
    };
  }
}
