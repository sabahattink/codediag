import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { DiagnosticIssue } from "../types.js";
import {
  type CallSteps,
  enclosingScope,
  isRequestValue,
  isTainted,
  LOCAL_TAINT,
  requestDecorator,
  type Taint,
  unwrap,
} from "./taint.js";

/**
 * Taint tracking across function boundaries: a sink's parameter is followed
 * to the call sites of its function, and a project function's result is
 * request data when it returns request data. Functions are resolved through
 * the type checker of the scan's shared ts-morph project, and only functions
 * in the scanned runtime source files are followed.
 */

/** Function boundaries one trace may cross: a helper calling a helper. */
export const MAX_CALL_DEPTH = 2;

export type FunctionLike =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration;

interface ParameterRef {
  fn: FunctionLike;
  index: number;
  /** A destructured parameter: the value is part of the argument. */
  destructured: boolean;
}

interface Frame {
  /** In a return summary: the parameter assumed to hold request data. */
  assumed?: { fn: FunctionLike; index: number };
  /** False in return summaries, which do not depend on any caller. */
  followsCallers: boolean;
}

/** A memoized result, or "pending" while it is being computed (recursion). */
type Memo<T> = Map<string, T | "pending">;

/** How a sink's input was found to carry request data. */
export interface Trace {
  /** True when the trace entered or left another function. */
  crossesCalls: boolean;
  /** The call that passes request data in, as `file:line`, if any. */
  origin?: string;
}

function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

/** Parameters a caller passes arguments for: without a TypeScript `this`. */
function callParameters(fn: FunctionLike): Node[] {
  return fn
    .getParameters()
    .filter((parameter) => parameter.getName() !== "this");
}

/** The function parameter an identifier refers to, if any. */
function parameterOf(identifier: Node): ParameterRef | undefined {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    let parameter: Node | undefined = declaration;
    while (
      parameter &&
      (Node.isBindingElement(parameter) ||
        Node.isObjectBindingPattern(parameter) ||
        Node.isArrayBindingPattern(parameter))
    ) {
      parameter = parameter.getParent();
    }
    if (
      !Node.isParameterDeclaration(parameter) ||
      parameter.isRestParameter()
    ) {
      continue;
    }
    const fn = parameter.getParent();
    if (!isFunctionLike(fn)) continue;
    const index = callParameters(fn).indexOf(parameter);
    if (index >= 0) {
      return { fn, index, destructured: parameter !== declaration };
    }
  }
  return undefined;
}

/** The function a declaration defines, such as `const f = () => ...`. */
function functionOf(declaration: Node, depth = 0): FunctionLike | undefined {
  if (
    (Node.isFunctionDeclaration(declaration) ||
      Node.isMethodDeclaration(declaration)) &&
    declaration.hasBody()
  ) {
    return declaration;
  }
  if (
    Node.isVariableDeclaration(declaration) ||
    Node.isPropertyAssignment(declaration) ||
    Node.isPropertyDeclaration(declaration)
  ) {
    const initializer = declaration.getInitializer();
    const value = initializer ? unwrap(initializer) : undefined;
    return isFunctionLike(value) ? value : undefined;
  }
  // `module.exports = { helper }`: the property refers to the function.
  if (Node.isShorthandPropertyAssignment(declaration) && depth === 0) {
    for (const target of declaration.getValueSymbol()?.getDeclarations() ??
      []) {
      const fn = functionOf(target, depth + 1);
      if (fn) return fn;
    }
  }
  return undefined;
}

/** Names call sites may use for a function, before checking the symbol. */
function functionNames(fn: FunctionLike): string[] {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    const name = fn.getName();
    return name ? [name] : [];
  }
  const parent = fn.getParent();
  if (
    Node.isVariableDeclaration(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isPropertyDeclaration(parent)
  ) {
    return [parent.getName()];
  }
  const name = Node.isFunctionExpression(fn) ? fn.getName() : undefined;
  return name ? [name] : [];
}

/** Methods are called on an object; other functions by name or on a module. */
function isMethodLike(fn: FunctionLike): boolean {
  const parent = fn.getParent();
  return (
    Node.isMethodDeclaration(fn) ||
    Node.isPropertyAssignment(parent) ||
    Node.isPropertyDeclaration(parent)
  );
}

interface ModuleNames {
  /** Names that call a function under another name: `import run from`. */
  renamed: Set<string>;
  /** Names bound to a whole module: `import * as lib`, `require("./lib")`. */
  objects: Set<string>;
}

function moduleNames(sourceFile: SourceFile): ModuleNames {
  const names: ModuleNames = { renamed: new Set(), objects: new Set() };
  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport()?.getText();
    if (defaultImport) {
      names.renamed.add(defaultImport);
      names.objects.add(defaultImport);
    }
    const namespace = declaration.getNamespaceImport()?.getText();
    if (namespace) names.objects.add(namespace);
    for (const namedImport of declaration.getNamedImports()) {
      const alias = namedImport.getAliasNode();
      if (alias) names.renamed.add(alias.getText());
    }
  }
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (
      !initializer ||
      !Node.isCallExpression(initializer) ||
      initializer.getExpression().getText() !== "require"
    ) {
      continue;
    }
    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      names.renamed.add(nameNode.getText());
      names.objects.add(nameNode.getText());
    } else if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        if (element.getPropertyNameNode()) names.renamed.add(element.getName());
      }
    }
  }
  return names;
}

interface IndexedCall {
  call: CallExpression;
  /** `run()`, `lib.run()` on a module, or `this.service.run()` on an object. */
  via: "name" | "module" | "member";
}

interface CallIndex {
  /** Calls by the callee's own name: `run` for `run()` and `this.svc.run()`. */
  byName: Map<string, IndexedCall[]>;
  /** Calls through a renamed import or require() binding. */
  renamed: CallExpression[];
}

function buildCallIndex(files: Iterable<SourceFile>): CallIndex {
  const index: CallIndex = { byName: new Map(), renamed: [] };
  for (const sourceFile of files) {
    const modules = moduleNames(sourceFile);
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const callee = unwrap(call.getExpression());
      let entry: IndexedCall;
      let name: string;
      if (Node.isIdentifier(callee)) {
        name = callee.getText();
        entry = { call, via: "name" };
        if (modules.renamed.has(name)) index.renamed.push(call);
      } else if (Node.isPropertyAccessExpression(callee)) {
        name = callee.getName();
        const receiver = callee.getExpression();
        entry = {
          call,
          via:
            Node.isIdentifier(receiver) &&
            modules.objects.has(receiver.getText())
              ? "module"
              : "member",
        };
      } else {
        continue;
      }
      const calls = index.byName.get(name);
      if (calls) calls.push(entry);
      else index.byName.set(name, [entry]);
    }
  }
  return index;
}

/** The values a function returns: return statements or an arrow's body. */
export function returnedValues(fn: FunctionLike): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  return body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((statement) => enclosingScope(statement) === fn)
    .flatMap((statement) => statement.getExpression() ?? []);
}

/**
 * Follows request data through the project's functions for one scan. Results
 * are memoized per function, parameter, and remaining call depth, so each
 * function is summarized once however many sinks reach it.
 */
export class CallTracer implements Taint, CallSteps {
  /**
   * The call that passes request data in during the current trace: of a
   * chain of helpers, the caller farthest from the sink.
   */
  private origin: CallExpression | undefined;
  private depth = 0;
  private frame: Frame = { followsCallers: true };
  private index: CallIndex | undefined;
  private readonly targets = new WeakMap<CallExpression, FunctionLike | null>();
  private readonly callerLists = new WeakMap<FunctionLike, CallExpression[]>();
  private readonly callerOrigins = new WeakMap<
    FunctionLike,
    Memo<CallExpression | null>
  >();
  private readonly returnSummaries = new WeakMap<FunctionLike, Memo<boolean>>();

  /** @param files The scanned runtime source files and their project paths. */
  constructor(private readonly files: ReadonlyMap<SourceFile, string>) {}

  /**
   * Runs a request-data check within the sink's function first and, when
   * that finds nothing, again through project functions. Null when neither
   * finds request data.
   */
  trace(check: (taint: Taint) => boolean): Trace | null {
    if (check(LOCAL_TAINT)) return { crossesCalls: false };
    this.origin = undefined;
    if (!check(this)) return null;
    const origin = this.origin;
    return {
      crossesCalls: true,
      ...(origin ? { origin: this.location(origin) } : {}),
    };
  }

  isRequestValue(node: Node): boolean {
    return isRequestValue(node, 0, this);
  }

  isTainted(node: Node): boolean {
    return isTainted(node, this);
  }

  throughCallers(
    value: Node,
    check: (argument: Node) => boolean,
  ): boolean | undefined {
    const node = unwrap(value);
    // A parameter injected from the request (`@Query("url")`) is request
    // data itself, whoever calls the method.
    if (
      !Node.isIdentifier(node) ||
      !this.frame.followsCallers ||
      requestDecorator(node)
    ) {
      return undefined;
    }
    const parameter = parameterOf(node);
    if (!parameter || parameter.destructured) return undefined;
    if (this.depth >= MAX_CALL_DEPTH) return false;
    for (const call of this.callers(parameter.fn)) {
      const argument = call.getArguments()[parameter.index];
      if (!argument || Node.isSpreadElement(argument)) continue;
      const found = this.inCaller(call, () => check(argument));
      if (found) {
        this.origin ??= found;
        return true;
      }
    }
    return false;
  }

  parameter(identifier: Node, strict: boolean): boolean {
    const parameter = parameterOf(identifier);
    if (!parameter) return false;
    const { assumed, followsCallers } = this.frame;
    if (!followsCallers) {
      return (
        assumed !== undefined &&
        assumed.fn === parameter.fn &&
        assumed.index === parameter.index
      );
    }
    if (this.depth >= MAX_CALL_DEPTH) return false;

    const key = `${parameter.index}:${strict}:${this.depth}`;
    const found = this.memoized(
      this.callerOrigins,
      parameter.fn,
      key,
      null,
      () => {
        for (const call of this.callers(parameter.fn)) {
          const argument = call.getArguments()[parameter.index];
          if (!argument || Node.isSpreadElement(argument)) continue;
          const origin = this.inCaller(call, () =>
            strict
              ? isRequestValue(argument, 0, this)
              : isTainted(argument, this),
          );
          if (origin) return origin;
        }
        return null;
      },
    );
    if (found) this.origin ??= found;
    return found !== null;
  }

  result(call: CallExpression): boolean {
    if (this.depth >= MAX_CALL_DEPTH) return false;
    const fn = this.target(call);
    if (!fn) return false;
    if (this.returnsRequestData(fn, undefined)) return true;
    return call
      .getArguments()
      .some(
        (argument, index) =>
          !Node.isSpreadElement(argument) &&
          this.returnsRequestData(fn, index) &&
          isRequestValue(argument, 0, this),
      );
  }

  /**
   * Whether a function returns request data it reads itself (no index), or
   * the request data its parameter at `index` receives.
   */
  private returnsRequestData(
    fn: FunctionLike,
    index: number | undefined,
  ): boolean {
    if (index !== undefined && index >= callParameters(fn).length) return false;
    const key = `${index ?? "own"}:${this.depth}`;
    return this.memoized(this.returnSummaries, fn, key, false, () =>
      this.enter(
        {
          followsCallers: false,
          ...(index === undefined ? {} : { assumed: { fn, index } }),
        },
        () =>
          returnedValues(fn).some((value) => isRequestValue(value, 0, this)),
      ),
    );
  }

  /**
   * Evaluates a check on a caller's argument one function boundary deeper.
   * Returns the call that passes request data in: a caller of this caller
   * when nested traces found one, or this call.
   */
  private inCaller(
    call: CallExpression,
    check: () => boolean,
  ): CallExpression | null {
    const outer = this.origin;
    this.origin = undefined;
    try {
      const found = this.enter({ followsCallers: true }, check);
      return found ? (this.origin ?? call) : null;
    } finally {
      this.origin = outer;
    }
  }

  private enter<T>(frame: Frame, evaluate: () => T): T {
    const outer = this.frame;
    this.frame = frame;
    this.depth++;
    try {
      return evaluate();
    } finally {
      this.depth--;
      this.frame = outer;
    }
  }

  /** Memoizes per function; a recursive request sees `fallback`. */
  private memoized<T>(
    memos: WeakMap<FunctionLike, Memo<T>>,
    fn: FunctionLike,
    key: string,
    fallback: T,
    compute: () => T,
  ): T {
    let memo = memos.get(fn);
    if (!memo) {
      memo = new Map();
      memos.set(fn, memo);
    }
    const cached = memo.get(key);
    if (cached === "pending") return fallback;
    if (cached !== undefined) return cached;
    memo.set(key, "pending");
    let value = fallback;
    try {
      value = compute();
    } finally {
      memo.set(key, value);
    }
    return value;
  }

  /** The project function a call invokes, through imports and instances. */
  private target(call: CallExpression): FunctionLike | null {
    const cached = this.targets.get(call);
    if (cached !== undefined) return cached;
    const callee = unwrap(call.getExpression());
    const nameNode = Node.isPropertyAccessExpression(callee)
      ? callee.getNameNode()
      : Node.isIdentifier(callee)
        ? callee
        : undefined;
    let symbol = nameNode?.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    let target: FunctionLike | null = null;
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const fn = functionOf(declaration);
      if (fn && this.files.has(fn.getSourceFile())) {
        target = fn;
        break;
      }
    }
    this.targets.set(call, target);
    return target;
  }

  /** Calls of a function in the scanned runtime files. */
  private callers(fn: FunctionLike): CallExpression[] {
    const cached = this.callerLists.get(fn);
    if (cached) return cached;
    this.index ??= buildCallIndex(this.files.keys());
    // Only plausible call shapes reach the type checker.
    const method = isMethodLike(fn);
    const candidates = new Set(
      functionNames(fn)
        .flatMap((name) => this.index?.byName.get(name) ?? [])
        .filter(({ via }) => (method ? via !== "name" : via !== "member"))
        .map(({ call }) => call),
    );
    if (!method) {
      for (const call of this.index.renamed) candidates.add(call);
    }
    const callers = [...candidates].filter((call) => this.target(call) === fn);
    this.callerLists.set(fn, callers);
    return callers;
  }

  private location(call: CallExpression): string {
    const file =
      this.files.get(call.getSourceFile()) ??
      call.getSourceFile().getBaseName();
    return `${file}:${call.getStartLineNumber()}`;
  }
}

/** The confidence and fix text of a finding whose input was traced. */
export function traceDetails(
  trace: Trace,
  fix: string,
): Pick<DiagnosticIssue, "confidence" | "fix"> {
  if (!trace.crossesCalls) return { fix };
  return {
    confidence: "medium",
    fix: trace.origin
      ? `Request data reaches this call from ${trace.origin}; ${fix.charAt(0).toLowerCase()}${fix.slice(1)}`
      : fix,
  };
}
