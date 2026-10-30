import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import type { DiagnosticIssue } from "../types.js";
import {
  CallGraph,
  type CallSite,
  callParameters,
  type FunctionLike,
  parameterOf,
  returnedValues,
} from "./taint-graph.js";
import { memberWrites } from "./taint-members.js";
import {
  type CallSteps,
  isRequestValue,
  isTainted,
  LOCAL_TAINT,
  requestDecorator,
  type Taint,
  unwrap,
} from "./taint.js";

/**
 * Taint tracking across function boundaries: a sink's parameter is followed
 * to the call sites of its function (`new` expressions for a constructor,
 * and the invoking function for an inline callback), a project function's
 * result is request data when it returns request data, and a field of `this`
 * holds what its class stores in it. taint-graph.ts resolves the calls.
 */

/** Function boundaries one trace may cross: a helper calling a helper. */
export const MAX_CALL_DEPTH = 2;

interface Frame {
  /** In a return summary: the parameter assumed to hold request data. */
  assumed?: { fn: FunctionLike; index: number };
  /** False in return summaries, which do not depend on any caller. */
  followsCallers: boolean;
  /**
   * Inside a function that invokes an inline callback: the one call that
   * passed the callback, whose arguments the function's parameters hold.
   */
  bound?: { fn: FunctionLike; call: CallSite };
}

/** The calls that pass a function's arguments and the frame to judge them in. */
interface ArgumentSites {
  calls: CallSite[];
  frame: Frame;
  /** False when the result depends on the current frame's bound call. */
  memoize: boolean;
}

/** A memoized result, or "pending" while it is being computed (recursion). */
type Memo<T> = Map<string, T | "pending">;

/** How a sink's input was found to carry request data. */
export interface Trace {
  /** True when the trace entered or left another function. */
  crossesCalls: boolean;
  /** Where request data enters, as `file:line`, if known. */
  origin?: string;
}

/**
 * Follows request data through the project's functions for one scan. Results
 * are memoized per function, parameter, and remaining call depth, and per
 * field write, so each function is summarized once however many sinks reach
 * it.
 */
export class CallTracer implements Taint, CallSteps {
  /**
   * Where request data enters during the current trace: of a chain of
   * helpers, the caller farthest from the sink; for a field, the `new`
   * expression or the write that stores it.
   */
  private origin: Node | undefined;
  private depth = 0;
  private frame: Frame = { followsCallers: true };
  private readonly graph: CallGraph;
  private readonly callerOrigins = new WeakMap<
    FunctionLike,
    Memo<Node | null>
  >();
  private readonly writeOrigins = new WeakMap<Node, Memo<Node | null>>();
  private readonly returnSummaries = new WeakMap<FunctionLike, Memo<boolean>>();

  /** @param files The scanned runtime source files and their project paths. */
  constructor(private readonly files: ReadonlyMap<SourceFile, string>) {
    this.graph = new CallGraph(files);
  }

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
    if (
      Node.isPropertyAccessExpression(node) &&
      Node.isThisExpression(node.getExpression())
    ) {
      return this.throughMember(node, check);
    }
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
    return this.throughArguments(parameter.fn, parameter.index, check);
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
    return this.fromCallers(parameter.fn, parameter.index, strict);
  }

  member(access: PropertyAccessExpression, strict: boolean): boolean {
    if (this.depth >= MAX_CALL_DEPTH) return false;
    for (const write of memberWrites(access)) {
      const key = `${strict}:${this.depth}`;
      const found = this.memoized(
        this.writeOrigins,
        write.node,
        key,
        null,
        () =>
          this.across(write.node, { followsCallers: true }, () => {
            if (write.parameter) {
              const { fn, index } = write.parameter;
              return this.fromCallers(fn, index, strict);
            }
            if (!write.value) return false;
            return strict
              ? isRequestValue(write.value, 0, this)
              : isTainted(write.value, this);
          }),
      );
      if (found) {
        this.origin ??= found;
        return true;
      }
    }
    return false;
  }

  result(call: CallExpression): boolean {
    if (this.depth >= MAX_CALL_DEPTH) return false;
    const fn = this.graph.target(call);
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
   * Whether a call site passes request data for a function's parameter at
   * `index`, strictly (`isRequestValue`) or visibly (`isTainted`).
   */
  private fromCallers(
    fn: FunctionLike,
    index: number,
    strict: boolean,
  ): boolean {
    if (this.depth >= MAX_CALL_DEPTH) return false;
    const sites = this.argumentSites(fn);
    const search = (): Node | null => {
      for (const call of sites.calls) {
        const argument = call.getArguments()[index];
        if (!argument || Node.isSpreadElement(argument)) continue;
        const origin = this.across(call, sites.frame, () =>
          strict
            ? isRequestValue(argument, 0, this)
            : isTainted(argument, this),
        );
        if (origin) return origin;
      }
      return null;
    };
    const key = `${index}:${strict}:${this.depth}`;
    const found = sites.memoize
      ? this.memoized(this.callerOrigins, fn, key, null, search)
      : search();
    if (found) this.origin ??= found;
    return found !== null;
  }

  /** Whether `check` holds for an argument a call site passes at `index`. */
  private throughArguments(
    fn: FunctionLike,
    index: number,
    check: (argument: Node) => boolean,
  ): boolean {
    if (this.depth >= MAX_CALL_DEPTH) return false;
    const sites = this.argumentSites(fn);
    for (const call of sites.calls) {
      const argument = call.getArguments()[index];
      if (!argument || Node.isSpreadElement(argument)) continue;
      const found = this.across(call, sites.frame, () => check(argument));
      if (found) {
        this.origin ??= found;
        return true;
      }
    }
    return false;
  }

  /**
   * For `this.name`: whether `check` holds for a value its class stores in
   * the field, or for the argument a `new` expression passes for the
   * constructor parameter that sets it. Undefined when nothing is stored.
   */
  private throughMember(
    access: PropertyAccessExpression,
    check: (value: Node) => boolean,
  ): boolean | undefined {
    const writes = memberWrites(access);
    if (writes.length === 0) return undefined;
    if (this.depth >= MAX_CALL_DEPTH) return false;
    for (const write of writes) {
      const found = this.across(write.node, { followsCallers: true }, () => {
        if (write.parameter) {
          const { fn, index } = write.parameter;
          return this.throughArguments(fn, index, check);
        }
        return write.value !== undefined && check(write.value);
      });
      if (found) {
        this.origin ??= found;
        return true;
      }
    }
    return false;
  }

  /**
   * The calls that pass a function's arguments: inside a function invoking
   * an inline callback, the one call that passed the callback; for an inline
   * callback, the receiving function's calls of it, judged with that
   * function's parameters bound to the passing call; otherwise its callers.
   */
  private argumentSites(fn: FunctionLike): ArgumentSites {
    const { bound } = this.frame;
    if (bound?.fn === fn) {
      return {
        calls: [bound.call],
        frame: { followsCallers: true },
        memoize: false,
      };
    }
    const callback = this.graph.callbackSite(fn);
    if (callback) {
      return {
        calls: callback.invocations,
        frame: {
          followsCallers: true,
          bound: { fn: callback.target, call: callback.call },
        },
        memoize: true,
      };
    }
    return {
      calls: this.graph.callers(fn),
      frame: { followsCallers: true },
      memoize: true,
    };
  }

  /**
   * Evaluates a check one function boundary away: at a call site, or where a
   * field is written. Returns where request data enters: the origin nested
   * traces found, or `site`.
   */
  private across(site: Node, frame: Frame, check: () => boolean): Node | null {
    const outer = this.origin;
    this.origin = undefined;
    try {
      const found = this.enter(frame, check);
      return found ? (this.origin ?? site) : null;
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

  /** Memoizes per function or write; a recursive request sees `fallback`. */
  private memoized<K extends Node, T>(
    memos: WeakMap<K, Memo<T>>,
    owner: K,
    key: string,
    fallback: T,
    compute: () => T,
  ): T {
    let memo = memos.get(owner);
    if (!memo) {
      memo = new Map();
      memos.set(owner, memo);
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

  private location(node: Node): string {
    const file =
      this.files.get(node.getSourceFile()) ??
      node.getSourceFile().getBaseName();
    return `${file}:${node.getStartLineNumber()}`;
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
