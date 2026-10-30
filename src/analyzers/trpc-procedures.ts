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
  importSource,
  isFunctionLike,
  literalText,
  type ModuleIndex,
  methodName,
  moduleOf,
  objectLiteral,
  propertyValue,
  receiverOf,
  unwrap,
} from "./fastify-plugins.js";
import { type FunctionLike, returnedValues } from "./taint-graph.js";
import {
  AUTH_NAMES,
  authenticates,
  bindingKey,
  bindingSource,
  importsTrpcAdapter,
  isCreateCall,
  leakedStack,
  localName,
  returnsArgument,
  trpcExport,
} from "./trpc-syntax.js";

/**
 * Resolves tRPC procedures across a project: `initTRPC...create()`
 * instances, the procedure builders derived from them (`t.procedure`, `.use()`
 * and `.input()` chains, exported builders such as `protectedProcedure`), the
 * routers that name procedures (`t.router`, T3's `createTRPCRouter`,
 * `mergeRouters`), and whether a builder's middleware authenticates.
 */

export type ProcedureKind = "mutation" | "query" | "subscription";
const PROCEDURE_KINDS: ReadonlySet<string> = new Set<ProcedureKind>([
  "mutation",
  "query",
  "subscription",
]);
/** Builder methods that return a builder with the same middleware. */
const PASS_THROUGH = new Set(["experimental_caller", "meta", "output"]);
/** Builder methods that append another builder's middleware and inputs. */
const CONCAT = new Set(["concat", "unstable_concat"]);
/** Middleware methods that run their receiver before their argument. */
const PIPE = new Set(["pipe", "unstable_pipe"]);
/** Builder names that promise a signed-in caller: `privateProcedure`. */
const PROTECTED_BUILDER_NAMES = new RegExp(
  `${AUTH_NAMES.source}|private|member|user`,
  "i",
);
/** Builders matched only by name, when their definition cannot be resolved. */
const BUILDER_NAMES = /procedure$/i;
/** Router factories matched only by name, when they cannot be resolved. */
const ROUTER_NAMES = /^(?:createTRPCRouter|router)$/;
/** Schema calls that accept every value when called without arguments. */
const ANY_SCHEMAS = new Set(["any", "custom", "unknown"]);
const SCHEMA_MODULES = /^(?:zod(?:\/.+)?|valibot)$/;
/** Schema modifiers that keep accepting what the wrapped schema accepts. */
const SCHEMA_WRAPPERS = new Set([
  "brand",
  "default",
  "describe",
  "nullable",
  "nullish",
  "optional",
  "readonly",
]);
/** Bounds alias, import, and factory chains; real code needs a few hops. */
const MAX_RESOLUTION_DEPTH = 8;

/** A `.use()` middleware and whether it authenticates the caller. */
export interface Middleware {
  auth: boolean;
  /** Its definition was not found, so `auth` is a guess from its name. */
  opaque: boolean;
}

export interface Builder {
  middleware: readonly Middleware[];
  /** The `.input()` calls of the chain, in order. */
  inputs: readonly CallExpression[];
  /** "low" when the chain starts at a builder matched only by name. */
  confidence: Confidence;
}

export interface Procedure {
  kind: ProcedureKind;
  call: CallExpression;
  builder: Builder;
  /** The dotted path from a root router, or a local name. */
  path: string;
  file: string;
  line: number;
}

export interface TrpcProject {
  procedures: Procedure[];
  routers: number;
  /** `initTRPC...create()` calls. */
  instances: CallExpression[];
  /** Files that import a tRPC adapter, which serves a router over HTTP. */
  adapters: number;
}

/** An `.input()` parser that accepts every value, and how it was judged. */
export interface PermissiveInput {
  /** The schema that accepts anything, or null for a casting function. */
  schema: string | null;
  confidence: Confidence;
}

export interface StackExposure {
  node: Node;
  /** `isDev: true`, or the `error.stack` access an errorFormatter returns. */
  via: "isDev" | "errorFormatter";
}

const OPAQUE: Middleware = { auth: false, opaque: true };

type RouterValue =
  | { kind: "procedure"; call: CallExpression }
  | { kind: "router"; call: CallExpression }
  | { kind: "record"; record: ObjectLiteralExpression };

/**
 * Resolves builders, middleware, and routers for one scan. Results are
 * memoized per node, so builders shared by many procedures are judged once.
 */
export class TrpcResolver {
  private readonly builders = new Map<Node, Builder | null>();
  private readonly verdicts = new Map<Node, Middleware>();
  private readonly routerKinds = new Map<Node, "router" | "merge" | null>();
  private readonly procedures = new Map<CallExpression, Procedure>();

  constructor(private readonly index: ModuleIndex) {}

  collect(
    sources: ReadonlyArray<{ file: string; sourceFile: SourceFile }>,
  ): TrpcProject {
    const instances: CallExpression[] = [];
    const routers: CallExpression[] = [];
    let adapters = 0;
    for (const { file, sourceFile } of sources) {
      if (importsTrpcAdapter(sourceFile)) adapters++;
      for (const call of sourceFile.getDescendantsOfKind(
        SyntaxKind.CallExpression,
      )) {
        if (isCreateCall(call)) instances.push(call);
        else if (this.routerKind(call)) routers.push(call);
        else this.addProcedure(file, call);
      }
    }
    const paths = this.procedurePaths(routers);
    const procedures = [...this.procedures.values()].map((procedure) => ({
      ...procedure,
      path: paths.get(procedure.call) ?? procedure.path,
    }));
    return { procedures, routers: routers.length, instances, adapters };
  }

  /**
   * The node that defines a value, narrowed to one binding when that is a
   * destructuring export: `router` in `export const { router, procedure } = t`.
   */
  private resolve(node: Node): Node | undefined {
    const resolved = definition(this.index, node);
    const pattern = Node.isVariableDeclaration(resolved)
      ? resolved.getNameNode()
      : undefined;
    if (!Node.isObjectBindingPattern(pattern)) return resolved;
    const value = unwrap(node);
    const declaration = Node.isIdentifier(value)
      ? value.getSymbol()?.getDeclarations()[0]
      : undefined;
    const name =
      (declaration && importSource(declaration)?.name) ?? value.getText();
    return pattern.getElements().find((element) => element.getName() === name);
  }

  /** The `initTRPC...create()` call an expression holds, if any. */
  instance(node: Node, depth = 0): CallExpression | null {
    const value = unwrap(node);
    if (Node.isCallExpression(value)) return isCreateCall(value) ? value : null;
    if (depth > MAX_RESOLUTION_DEPTH) return null;
    const resolved = this.resolve(value);
    const initializer = Node.isVariableDeclaration(resolved)
      ? resolved.getInitializer()
      : undefined;
    return initializer ? this.instance(initializer, depth + 1) : null;
  }

  /**
   * The procedure builder an expression evaluates to. Chains are followed
   * through `.use()`, `.input()`, variables, and imports back to
   * `t.procedure`; a builder that cannot be resolved is matched by a name
   * ending in "procedure" with low confidence.
   */
  builder(node: Node, depth = 0): Builder | null {
    const value = unwrap(node);
    const cached = this.builders.get(value);
    if (cached !== undefined) return cached;
    if (depth > MAX_RESOLUTION_DEPTH) return null;
    // Marked first, so a builder defined in terms of itself ends.
    this.builders.set(value, null);
    const result = this.evaluate(value, depth);
    this.builders.set(value, result);
    return result;
  }

  /** Why an `.input()` call's parser accepts every value, or null. */
  permissiveInput(call: CallExpression): PermissiveInput | null {
    const [parser] = call.getArguments();
    return parser ? this.permissive(parser, 0) : null;
  }

  /** Options of an `initTRPC...create()` call that send stacks to clients. */
  stackExposures(create: CallExpression): StackExposure[] {
    const options = objectLiteral(this.index, create.getArguments()[0]);
    if (!options) return [];
    const exposures: StackExposure[] = [];
    const isDev = options.getProperty("isDev");
    if (
      Node.isPropertyAssignment(isDev) &&
      isDev.getInitializer()?.getKind() === SyntaxKind.TrueKeyword
    ) {
      exposures.push({ node: isDev, via: "isDev" });
    }
    const formatter = this.functionOf(
      propertyValue(options.getProperty("errorFormatter")),
    );
    const leak = formatter && leakedStack(formatter);
    if (leak) exposures.push({ node: leak, via: "errorFormatter" });
    return exposures;
  }

  private addProcedure(file: string, call: CallExpression): void {
    const kind = methodName(call);
    const resolver = call.getArguments().at(-1);
    if (!PROCEDURE_KINDS.has(kind) || !resolver) return;
    // `client.post.byId.query({ id })` passes input, not a resolver.
    const value = unwrap(resolver);
    if (
      !isFunctionLike(value) &&
      !Node.isIdentifier(value) &&
      !Node.isPropertyAccessExpression(value)
    ) {
      return;
    }
    const builder = this.builder(receiverOf(call));
    if (!builder) return;
    const callee = call.getExpression();
    this.procedures.set(call, {
      kind: kind as ProcedureKind,
      call,
      builder,
      path: localName(call),
      file,
      line: Node.isPropertyAccessExpression(callee)
        ? callee.getNameNode().getStartLineNumber()
        : call.getStartLineNumber(),
    });
  }

  private evaluate(value: Node, depth: number): Builder | null {
    if (Node.isCallExpression(value)) return this.chained(value, depth);
    if (
      Node.isPropertyAccessExpression(value) &&
      value.getName() === "procedure"
    ) {
      const instance = this.instance(value.getExpression(), depth + 1);
      return {
        middleware: [],
        inputs: [],
        confidence: instance ? "high" : "low",
      };
    }
    if (!Node.isIdentifier(value) && !Node.isPropertyAccessExpression(value)) {
      return null;
    }
    const resolved = this.resolve(value);
    if (Node.isVariableDeclaration(resolved)) {
      const initializer = resolved.getInitializer();
      const built = initializer && this.builder(initializer, depth + 1);
      if (built) return built;
    }
    // const { procedure } = t
    const source = resolved && bindingSource(resolved);
    if (
      resolved &&
      bindingKey(resolved) === "procedure" &&
      source &&
      this.instance(source, depth + 1)
    ) {
      return { middleware: [], inputs: [], confidence: "high" };
    }
    return this.namedBuilder(value, resolved);
  }

  /** `.use()`, `.input()`, and other builder methods on a builder. */
  private chained(call: CallExpression, depth: number): Builder | null {
    const name = methodName(call);
    if (
      name !== "use" &&
      name !== "input" &&
      !PASS_THROUGH.has(name) &&
      !CONCAT.has(name)
    ) {
      return null;
    }
    const base = this.builder(receiverOf(call), depth);
    if (!base) return null;
    const [argument] = call.getArguments();
    if (name === "input") return { ...base, inputs: [...base.inputs, call] };
    if (name === "use") {
      return argument
        ? {
            ...base,
            middleware: [...base.middleware, this.middleware(argument)],
          }
        : base;
    }
    if (CONCAT.has(name)) {
      const other = argument && this.builder(argument, depth + 1);
      return {
        ...base,
        middleware: [...base.middleware, ...(other?.middleware ?? [OPAQUE])],
        inputs: [...base.inputs, ...(other?.inputs ?? [])],
      };
    }
    return base;
  }

  /** A builder known only by its name, such as an imported `protectedProcedure`. */
  private namedBuilder(
    value: Node,
    resolved: Node | undefined,
  ): Builder | null {
    const name = Node.isPropertyAccessExpression(value)
      ? value.getName()
      : value.getText();
    if (!BUILDER_NAMES.test(name)) return null;
    // A parameter's type may name the builder it receives: `typeof adminProcedure`.
    const typed = Node.isParameterDeclaration(resolved)
      ? (resolved.getTypeNode()?.getText() ?? "")
      : "";
    const named =
      PROTECTED_BUILDER_NAMES.test(name) || PROTECTED_BUILDER_NAMES.test(typed);
    return {
      middleware: named ? [{ auth: true, opaque: true }] : [],
      inputs: [],
      confidence: "low",
    };
  }

  /**
   * What a `.use()` argument does. Middleware whose definition is found is
   * judged by its code; anything else by its name, and marked opaque.
   */
  private middleware(node: Node, depth = 0): Middleware {
    const value = unwrap(node);
    const cached = this.verdicts.get(value);
    if (cached) return cached;
    this.verdicts.set(value, OPAQUE);
    const verdict =
      depth > MAX_RESOLUTION_DEPTH
        ? { auth: AUTH_NAMES.test(value.getText()), opaque: true }
        : this.judge(value, depth);
    this.verdicts.set(value, verdict);
    return verdict;
  }

  private judge(value: Node, depth: number): Middleware {
    if (isFunctionLike(value)) {
      return { auth: authenticates(value), opaque: false };
    }
    if (Node.isCallExpression(value)) return this.judgeCall(value, depth);
    if (!Node.isIdentifier(value) && !Node.isPropertyAccessExpression(value)) {
      return OPAQUE;
    }
    const name = Node.isPropertyAccessExpression(value)
      ? value.getName()
      : value.getText();
    const resolved = this.resolve(value);
    const target = Node.isVariableDeclaration(resolved)
      ? resolved.getInitializer()
      : isFunctionLike(resolved)
        ? resolved
        : undefined;
    const inner = target ? this.middleware(target, depth + 1) : OPAQUE;
    return { auth: inner.auth || AUTH_NAMES.test(name), opaque: inner.opaque };
  }

  /**
   * `t.middleware(fn)` and `isAuthed.unstable_pipe(fn)` are judged by the
   * middleware they combine; a project factory such as `requireRole("admin")`
   * by the middleware it returns.
   */
  private judgeCall(call: CallExpression, depth: number): Middleware {
    const callee = call.getExpression();
    const name = methodName(call) || callee.getText();
    const named = AUTH_NAMES.test(name);
    const resolved = Node.isIdentifier(callee)
      ? this.resolve(callee)
      : undefined;
    const initializer = Node.isVariableDeclaration(resolved)
      ? resolved.getInitializer()
      : resolved;
    const factory = initializer && unwrap(initializer);
    const parts = isFunctionLike(factory)
      ? returnedValues(factory)
      : [
          ...(PIPE.has(name) ? [receiverOf(call)] : []),
          ...call
            .getArguments()
            .filter(
              (argument) =>
                isFunctionLike(unwrap(argument)) ||
                Node.isIdentifier(unwrap(argument)) ||
                Node.isPropertyAccessExpression(unwrap(argument)) ||
                Node.isCallExpression(unwrap(argument)),
            ),
        ];
    const verdicts = parts.map((part) => this.middleware(part, depth + 1));
    return {
      auth: named || verdicts.some((verdict) => verdict.auth),
      opaque:
        verdicts.length === 0 || verdicts.some((verdict) => verdict.opaque),
    };
  }

  private permissive(node: Node, depth: number): PermissiveInput | null {
    const value = unwrap(node);
    if (depth > MAX_RESOLUTION_DEPTH) return null;
    if (isFunctionLike(value)) {
      return returnsArgument(value)
        ? { schema: null, confidence: "high" }
        : null;
    }
    if (Node.isIdentifier(value)) {
      // const anyInput = z.any(), also imported from a schema module
      const resolved = this.resolve(value);
      const initializer = Node.isVariableDeclaration(resolved)
        ? resolved.getInitializer()
        : undefined;
      return initializer ? this.permissive(initializer, depth + 1) : null;
    }
    if (!Node.isCallExpression(value)) return null;
    const name = methodName(value);
    if (SCHEMA_WRAPPERS.has(name)) {
      // z.any().optional() wraps its receiver; v.optional(v.any()) its argument.
      const receiver = unwrap(receiverOf(value));
      const wrapped = Node.isCallExpression(receiver)
        ? receiver
        : value.getArguments()[0];
      return wrapped ? this.permissive(wrapped, depth + 1) : null;
    }
    if (!ANY_SCHEMAS.has(name) || value.getArguments().length > 0) return null;
    const namespace = receiverOf(value);
    const module = moduleOf(namespace);
    const schema = module !== null && SCHEMA_MODULES.test(module);
    if (!schema && namespace.getText() !== "z") return null;
    return { schema: value.getText(), confidence: schema ? "high" : "low" };
  }

  /** The function a property or variable holds: `errorFormatter(opts) {}`. */
  private functionOf(node: Node | undefined): FunctionLike | undefined {
    if (!node) return undefined;
    if (Node.isMethodDeclaration(node)) return node;
    const value = this.resolve(node);
    const target = Node.isVariableDeclaration(value)
      ? value.getInitializer()
      : value;
    const fn = target && unwrap(target);
    return isFunctionLike(fn) ? fn : undefined;
  }

  /** "router" for `t.router` and its aliases, "merge" for `mergeRouters`. */
  private routerKind(call: CallExpression): "router" | "merge" | null {
    const kind = this.factoryKind(call.getExpression(), 0);
    if (kind === "router") {
      return objectLiteral(this.index, call.getArguments()[0]) ? kind : null;
    }
    return kind;
  }

  private factoryKind(node: Node, depth: number): "router" | "merge" | null {
    const value = unwrap(node);
    const cached = this.routerKinds.get(value);
    if (cached !== undefined) return cached;
    this.routerKinds.set(value, null);
    const kind =
      depth > MAX_RESOLUTION_DEPTH ? null : this.resolveFactory(value, depth);
    this.routerKinds.set(value, kind);
    return kind;
  }

  private resolveFactory(
    value: Node,
    depth: number,
  ): "router" | "merge" | null {
    const asKind = (name: string | null) =>
      name === "router" ? "router" : name === "mergeRouters" ? "merge" : null;
    if (Node.isPropertyAccessExpression(value)) {
      const kind = asKind(value.getName());
      return kind && this.instance(value.getExpression(), depth + 1)
        ? kind
        : null;
    }
    // Router factories are named after routers; other calls stay cheap.
    if (!Node.isIdentifier(value) || !/router/i.test(value.getText())) {
      return null;
    }
    if (trpcExport(value) === "mergeRouters") return "merge";
    const resolved = this.resolve(value);
    if (Node.isVariableDeclaration(resolved)) {
      const initializer = resolved.getInitializer();
      return initializer ? this.factoryKind(initializer, depth + 1) : null;
    }
    // const { router, mergeRouters } = t
    const source = resolved && bindingSource(resolved);
    const kind = resolved ? asKind(bindingKey(resolved)) : null;
    if (kind && source && this.instance(source, depth + 1)) return kind;
    return ROUTER_NAMES.test(value.getText()) ? "router" : null;
  }

  /** A router's record entries and the routers mergeRouters() combines. */
  private members(call: CallExpression): Array<{ key: string; node: Node }> {
    const kind = this.routerKind(call);
    if (kind === "merge") {
      return call.getArguments().map((node) => ({ key: "", node }));
    }
    const record = objectLiteral(this.index, call.getArguments()[0]);
    return record ? this.recordMembers(record, 0) : [];
  }

  private recordMembers(
    record: ObjectLiteralExpression,
    depth: number,
  ): Array<{ key: string; node: Node }> {
    return record.getProperties().flatMap((property) => {
      if (Node.isSpreadAssignment(property)) {
        // ...sharedProcedures: their keys join this record.
        const spread = objectLiteral(this.index, property.getExpression());
        return spread && depth < MAX_RESOLUTION_DEPTH
          ? this.recordMembers(spread, depth + 1)
          : [];
      }
      if (
        !Node.isPropertyAssignment(property) &&
        !Node.isShorthandPropertyAssignment(property)
      ) {
        return [];
      }
      const node = propertyValue(property);
      const nameNode = property.getNameNode();
      const key = literalText(nameNode) ?? nameNode.getText();
      return node ? [{ key, node }] : [];
    });
  }

  /** What a router entry holds: a procedure, a router, or a nested record. */
  private routerValue(node: Node, depth: number): RouterValue | null {
    const value = unwrap(node);
    if (Node.isCallExpression(value)) {
      if (this.procedures.has(value)) return { kind: "procedure", call: value };
      return this.routerKind(value) ? { kind: "router", call: value } : null;
    }
    if (Node.isObjectLiteralExpression(value)) {
      return { kind: "record", record: value };
    }
    if (depth > MAX_RESOLUTION_DEPTH) return null;
    const resolved = this.resolve(value);
    const initializer = Node.isVariableDeclaration(resolved)
      ? resolved.getInitializer()
      : undefined;
    return initializer ? this.routerValue(initializer, depth + 1) : null;
  }

  /**
   * Dotted paths such as `post.create`, from the routers that no other router
   * includes. A procedure reachable in several places keeps its first path.
   */
  private procedurePaths(
    routers: CallExpression[],
  ): Map<CallExpression, string> {
    const children = new Set<CallExpression>();
    const entries = new Map(
      routers.map((router) => [
        router,
        this.members(router).flatMap(({ key, node }) => {
          const value = this.routerValue(node, 0);
          if (value?.kind === "router") children.add(value.call);
          return value ? [{ key, value }] : [];
        }),
      ]),
    );
    const paths = new Map<CallExpression, string>();
    const join = (prefix: string, key: string) =>
      [prefix, key].filter(Boolean).join(".");
    const visit = (
      members: Array<{ key: string; value: RouterValue }>,
      prefix: string,
      visiting: Set<Node>,
    ): void => {
      for (const { key, value } of members) {
        const path = join(prefix, key);
        if (value.kind === "procedure") {
          if (!paths.has(value.call)) paths.set(value.call, path);
        } else if (value.kind === "record") {
          if (visiting.has(value.record)) continue;
          visiting.add(value.record);
          const nested = this.recordMembers(value.record, 0).flatMap(
            ({ key: nestedKey, node }) => {
              const nestedValue = this.routerValue(node, 0);
              return nestedValue
                ? [{ key: nestedKey, value: nestedValue }]
                : [];
            },
          );
          visit(nested, path, visiting);
          visiting.delete(value.record);
        } else if (!visiting.has(value.call)) {
          visiting.add(value.call);
          visit(entries.get(value.call) ?? [], path, visiting);
          visiting.delete(value.call);
        }
      }
    };
    for (const router of routers) {
      if (!children.has(router)) {
        visit(entries.get(router) ?? [], "", new Set([router]));
      }
    }
    // Routers that only include each other in a cycle name their own entries.
    for (const router of routers) {
      visit(entries.get(router) ?? [], "", new Set([router]));
    }
    return paths;
  }
}
