import {
  type ArrowFunction,
  type CallExpression,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type NewExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { add, enclosingScope, unwrap } from "./taint.js";

/**
 * The call graph taint tracking follows: which project function a call or
 * `new` expression runs, where a function is called, and where a function
 * that receives an inline callback invokes it. Functions are resolved
 * through the type checker of the scan's shared ts-morph project, and only
 * functions in the scanned runtime source files count.
 */

export type FunctionLike =
  | ArrowFunction
  | ConstructorDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration;

/** A call or `new` expression that passes arguments to a project function. */
export type CallSite = CallExpression | NewExpression;

export interface ParameterRef {
  fn: FunctionLike;
  index: number;
  /** A destructured parameter: the value is part of the argument. */
  destructured: boolean;
}

/** Where a project function invokes a callback written inline in a call. */
export interface CallbackSite {
  /** The project function that receives the callback. */
  target: FunctionLike;
  /** The call that passes the callback to it. */
  call: CallExpression;
  /** The target's calls of the callback parameter: `visit(name)`. */
  invocations: CallExpression[];
}

function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  );
}

/** Parameters a caller passes arguments for: without a TypeScript `this`. */
export function callParameters(fn: FunctionLike): Node[] {
  return fn
    .getParameters()
    .filter((parameter) => parameter.getName() !== "this");
}

/** The function parameter an identifier refers to, if any. */
export function parameterOf(identifier: Node): ParameterRef | undefined {
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

/** The constructor `new` runs for a class: `class X { constructor() {} }`. */
function constructorOf(declaration: Node): ConstructorDeclaration | undefined {
  const owner = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : declaration;
  if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) {
    return undefined;
  }
  return owner.getConstructors().find((fn) => fn.hasBody());
}

/** Names call sites may use for a function, before checking the symbol. */
function functionNames(fn: FunctionLike): string[] {
  if (Node.isConstructorDeclaration(fn)) {
    const owner = fn.getParent();
    if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) {
      return [];
    }
    const holder = owner.getParent();
    return [
      owner.getName(),
      Node.isVariableDeclaration(holder) ? holder.getName() : undefined,
    ].filter((name) => name !== undefined);
  }
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
  /** `new` expressions by class name: `Job` for `new Job()`, `new lib.Job()`. */
  constructions: Map<string, NewExpression[]>;
  /** `new` expressions through a renamed import or require() binding. */
  renamedConstructions: NewExpression[];
}

function buildCallIndex(files: Iterable<SourceFile>): CallIndex {
  const index: CallIndex = {
    byName: new Map(),
    renamed: [],
    constructions: new Map(),
    renamedConstructions: [],
  };
  for (const sourceFile of files) {
    const modules = moduleNames(sourceFile);
    for (const expression of sourceFile.getDescendantsOfKind(
      SyntaxKind.NewExpression,
    )) {
      const callee = unwrap(expression.getExpression());
      if (Node.isIdentifier(callee)) {
        add(index.constructions, callee.getText(), expression);
        if (modules.renamed.has(callee.getText())) {
          index.renamedConstructions.push(expression);
        }
      } else if (Node.isPropertyAccessExpression(callee)) {
        add(index.constructions, callee.getName(), expression);
      }
    }
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
      add(index.byName, name, entry);
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

/** Calls inside a function of its own parameter at `index`: `visit(name)`. */
function invocations(fn: FunctionLike, index: number): CallExpression[] {
  const parameter = callParameters(fn)[index];
  if (!Node.isParameterDeclaration(parameter)) return [];
  const name = parameter.getName();
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const callee = unwrap(call.getExpression());
    if (!Node.isIdentifier(callee) || callee.getText() !== name) return false;
    const reference = parameterOf(callee);
    return (
      reference?.fn === fn &&
      reference.index === index &&
      !reference.destructured
    );
  });
}

/** Call resolution for one scan, cached per call site and function. */
export class CallGraph {
  private index: CallIndex | undefined;
  private readonly targets = new WeakMap<CallSite, FunctionLike | null>();
  private readonly callerLists = new WeakMap<FunctionLike, CallSite[]>();
  private readonly callbackSites = new WeakMap<
    FunctionLike,
    CallbackSite | null
  >();

  /** @param files The scanned runtime source files and their project paths. */
  constructor(private readonly files: ReadonlyMap<SourceFile, string>) {}

  /**
   * The project function a call invokes, through imports and instances, or
   * the project constructor a `new` expression runs.
   */
  target(call: CallSite): FunctionLike | null {
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
    const declarations = symbol?.getDeclarations() ?? [];
    let target: FunctionLike | null;
    if (Node.isNewExpression(call)) {
      // `const Service = require("./service")`: the binding's type is the
      // class.
      const candidates = declarations.some((node) => constructorOf(node))
        ? declarations
        : (callee.getType().getSymbol()?.getDeclarations() ?? []);
      target = this.inFiles(candidates.map(constructorOf));
    } else {
      target = this.inFiles(declarations.map((node) => functionOf(node)));
    }
    this.targets.set(call, target);
    return target;
  }

  /** Calls of a function, or `new` expressions of a class, in the scan. */
  callers(fn: FunctionLike): CallSite[] {
    const cached = this.callerLists.get(fn);
    if (cached) return cached;
    this.index ??= buildCallIndex(this.files.keys());
    const index = this.index;
    // Only plausible call shapes reach the type checker.
    const candidates = new Set<CallSite>();
    if (Node.isConstructorDeclaration(fn)) {
      for (const name of functionNames(fn)) {
        for (const site of index.constructions.get(name) ?? []) {
          candidates.add(site);
        }
      }
      for (const site of index.renamedConstructions) candidates.add(site);
    } else {
      const method = isMethodLike(fn);
      for (const name of functionNames(fn)) {
        for (const { call, via } of index.byName.get(name) ?? []) {
          if (method ? via !== "name" : via !== "member") candidates.add(call);
        }
      }
      if (!method) {
        for (const call of index.renamed) candidates.add(call);
      }
    }
    const callers = [...candidates].filter((call) => this.target(call) === fn);
    this.callerLists.set(fn, callers);
    return callers;
  }

  /**
   * For a callback written inline as an argument of a call to a project
   * function, such as `each(items, (item) => ...)`: that function and its
   * calls of the callback parameter.
   */
  callbackSite(fn: FunctionLike): CallbackSite | null {
    const cached = this.callbackSites.get(fn);
    if (cached !== undefined) return cached;
    let site: CallbackSite | null = null;
    const call = fn.getParent();
    if (
      (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) &&
      Node.isCallExpression(call)
    ) {
      const position = call.getArguments().indexOf(fn);
      const target = position >= 0 ? this.target(call) : null;
      if (target) {
        site = { target, call, invocations: invocations(target, position) };
      }
    }
    this.callbackSites.set(fn, site);
    return site;
  }

  /** The first function defined in the scanned runtime files. */
  private inFiles(
    functions: Array<FunctionLike | undefined>,
  ): FunctionLike | null {
    return (
      functions.find((fn) => fn && this.files.has(fn.getSourceFile())) ?? null
    );
  }
}
