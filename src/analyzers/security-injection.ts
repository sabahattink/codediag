import {
  type CallExpression,
  type Expression,
  type NewExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";
import { type CallTracer, type Trace, traceDetails } from "./taint-calls.js";
import {
  enclosingScope,
  type ModuleBindings,
  moduleBindings,
  moduleCall,
  type Taint,
} from "./taint.js";

interface TemplateEngine {
  modules: Set<string>;
  /** Functions that compile or render their first argument as a template. */
  functions: Set<string>;
  /** The module's default export is itself the compile function. */
  callableDefault?: boolean;
}

const TEMPLATE_ENGINES: TemplateEngine[] = [
  { modules: new Set(["ejs"]), functions: new Set(["compile", "render"]) },
  {
    modules: new Set(["pug", "jade"]),
    functions: new Set(["compile", "compileClient", "render"]),
  },
  {
    modules: new Set(["handlebars"]),
    functions: new Set(["compile", "precompile"]),
  },
  {
    modules: new Set(["nunjucks"]),
    functions: new Set(["compile", "renderString"]),
  },
  {
    modules: new Set(["eta"]),
    functions: new Set([
      "compile",
      "render",
      "renderString",
      "renderStringAsync",
    ]),
  },
  { modules: new Set(["dot"]), functions: new Set(["compile", "template"]) },
  {
    modules: new Set(["lodash", "lodash-es", "underscore"]),
    functions: new Set(["template"]),
  },
  {
    modules: new Set(["lodash.template"]),
    functions: new Set(),
    callableDefault: true,
  },
];

/** Code that rejects prototype keys before a recursive merge copies them. */
const MERGE_GUARD =
  /__proto__|["'`](?:constructor|prototype)["'`]|Object\.create\(\s*null\s*\)/;
/** A nested write is also safe behind an own-property or allowlist check. */
const WRITE_GUARD = new RegExp(
  `${MERGE_GUARD.source}|\\bhasOwn(?:Property)?\\s*\\(|\\.(?:has|includes)\\s*\\(`,
);
const FUNCTION_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
] as const;
const KEY_ITERATION =
  /\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+in\b|\b(?:Object\.(?:keys|entries|getOwnPropertyNames)|Reflect\.ownKeys)\s*\(/;

/** The template source argument when a call compiles request data. */
function compiledTemplate(
  call: CallExpression,
  engines: Array<{ engine: TemplateEngine; bindings: ModuleBindings }>,
  taint: Taint,
): Node | undefined {
  const expression = call.getExpression();
  const isCompile = engines.some(
    ({ engine, bindings }) =>
      moduleCall(call, bindings, engine.modules, engine.functions) ||
      (engine.callableDefault &&
        Node.isIdentifier(expression) &&
        bindings.namespaces.has(expression.getText())),
  );
  const [source] = call.getArguments();
  return isCompile && source && taint.isRequestValue(source)
    ? source
    : undefined;
}

/** `new nunjucks.Template(source)` from request data. */
function constructedTemplate(
  expression: NewExpression,
  nunjucks: ModuleBindings,
  taint: Taint,
): boolean {
  const callee = expression.getExpression();
  const [source] = expression.getArguments();
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "Template" &&
    nunjucks.namespaces.has(callee.getExpression().getText()) &&
    source !== undefined &&
    taint.isRequestValue(source)
  );
}

/** The keys of `target[a][b][c]` that choose an object to write into: a, b. */
function containerKeys(target: Node): Expression[] {
  const keys: Expression[] = [];
  let container = Node.isElementAccessExpression(target)
    ? target.getExpression()
    : undefined;
  while (container && Node.isElementAccessExpression(container)) {
    const key = container.getArgumentExpression();
    if (key) keys.push(key);
    container = container.getExpression();
  }
  return keys;
}

function functionName(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getName();
  }
  if (Node.isFunctionExpression(node) && node.getName()) return node.getName();
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return undefined;
}

/** A function that copies keys by name into a target and calls itself. */
function isUnguardedRecursiveMerge(node: Node): boolean {
  const name = functionName(node);
  if (!name) return false;
  const text = node.getText();
  if (!KEY_ITERATION.test(text) || MERGE_GUARD.test(text)) return false;

  const writesComputedKey = node
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .some((binary) => {
      const left = binary.getLeft();
      return (
        binary.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        Node.isElementAccessExpression(left) &&
        Node.isIdentifier(left.getArgumentExpression())
      );
    });
  const callsItself = node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) =>
      [name, `this.${name}`].includes(call.getExpression().getText()),
    );
  return writesComputedKey && callsItself;
}

function templateInjection(
  file: string,
  line: number,
  trace: Trace,
): DiagnosticIssue {
  return {
    ...fromRule("server-side-template-injection"),
    message: "A template is compiled from request data",
    file,
    line,
    ...traceDetails(
      trace,
      "Load templates from files or constants and pass request data only as template variables",
    ),
  };
}

/**
 * Server-side template injection and prototype pollution: request data used
 * as template source or as an object path, and recursive merges that copy
 * `__proto__`.
 */
export function inspectInjection(
  sourceFile: SourceFile,
  file: string,
  tracer: CallTracer,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const engines = TEMPLATE_ENGINES.map((engine) => ({
    engine,
    bindings: moduleBindings(sourceFile, engine.modules, engine.functions),
  }));
  const nunjucks = moduleBindings(sourceFile, new Set(["nunjucks"]), new Set());

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const trace = tracer.trace(
      (taint) => compiledTemplate(call, engines, taint) !== undefined,
    );
    if (trace) {
      issues.push(templateInjection(file, call.getStartLineNumber(), trace));
    }
  }
  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    const trace = tracer.trace((taint) =>
      constructedTemplate(expression, nunjucks, taint),
    );
    if (trace) {
      issues.push(
        templateInjection(file, expression.getStartLineNumber(), trace),
      );
    }
  }

  for (const binary of sourceFile.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      continue;
    }
    const keys = containerKeys(binary.getLeft());
    const trace =
      keys.length > 0 && !WRITE_GUARD.test(enclosingScope(binary).getText())
        ? tracer.trace((taint) => keys.some((key) => taint.isRequestValue(key)))
        : null;
    if (trace) {
      issues.push({
        ...fromRule("prototype-pollution"),
        message: "A nested object write uses keys from request data",
        file,
        line: binary.getStartLineNumber(),
        ...traceDetails(
          trace,
          "Reject __proto__, constructor, and prototype keys, check keys against an allowlist, or store the data in a Map",
        ),
      });
    }
  }

  for (const kind of FUNCTION_KINDS) {
    for (const node of sourceFile.getDescendantsOfKind(kind)) {
      if (!isUnguardedRecursiveMerge(node)) continue;
      issues.push({
        ...fromRule("prototype-pollution"),
        severity: "warning",
        confidence: "medium",
        message:
          "A recursive merge copies keys without rejecting __proto__, constructor, and prototype",
        file,
        line: node.getStartLineNumber(),
        fix: "Skip __proto__, constructor, and prototype keys, or use a maintained merge such as current lodash.merge",
      });
    }
  }

  return issues.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
}
