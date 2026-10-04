import { posix } from "node:path";
import {
  type CallExpression,
  type Expression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

const HTTP_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

const MUTATING_METHODS = new Set(["delete", "patch", "post", "put"]);
const BODY_METHODS = new Set(["patch", "post", "put"]);
/** Receivers matched only by name, when their creation cannot be resolved. */
const ROUTER_NAMES = /(?:^|\.)(?:app|api|router)$|router/i;
const ROUTER_TYPES =
  /^(?:[A-Za-z_$][\w$]*\.)?(?:Express|Application|Router|IRouter)$/;
const AUTH_NAMES =
  /auth|authenticate|authorize|permission|permit|protect|require.*(?:user|role|login)|jwt/i;
const VALIDATION_NAMES =
  /valid|schema|sanitize|zod|joi|yup|ajv|check(?:body|params|query)/i;
const ERROR_NAMES = /error|exception/i;
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];
const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs,cjs}";

type Confidence = "high" | "low";

interface RouterBinding {
  id: string;
  confidence: Confidence;
}

interface UseCall {
  router: string;
  file: string;
  position: number;
  path: string;
  middleware: string[];
  mounts: string[];
}

interface Route {
  router: string;
  confidence: Confidence;
  method: string;
  path: string;
  file: string;
  line: number;
  position: number;
  middleware: string[];
}

interface FileRouters {
  /** Local names bound to routers and apps created or typed in this file. */
  locals: Map<string, RouterBinding>;
  /** Export name ("default" for default and module.exports) to router id. */
  exports: Map<string, string>;
}

interface Protection {
  auth: boolean;
  validation: boolean;
}

function literalText(node: Node | undefined): string | null {
  return node &&
    (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    ? node.getLiteralText()
    : null;
}

function requiredModule(node: Node | undefined): string | null {
  if (!node || !Node.isCallExpression(node)) return null;
  if (node.getExpression().getText() !== "require") return null;
  return literalText(node.getArguments()[0]);
}

/** Names bound to the express module and to its Router factory. */
function expressBindings(sourceFile: SourceFile): {
  modules: Set<string>;
  routerFactories: Set<string>;
} {
  const modules = new Set<string>();
  const routerFactories = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== "express") continue;
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) modules.add(defaultImport.getText());
    const namespace = declaration.getNamespaceImport();
    if (namespace) modules.add(namespace.getText());
    for (const named of declaration.getNamedImports()) {
      if (named.getName() === "Router") {
        routerFactories.add(named.getAliasNode()?.getText() ?? "Router");
      }
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (requiredModule(declaration.getInitializer()) !== "express") continue;
    const name = declaration.getNameNode();
    if (Node.isIdentifier(name)) {
      modules.add(name.getText());
    } else if (Node.isObjectBindingPattern(name)) {
      for (const element of name.getElements()) {
        const imported =
          element.getPropertyNameNode()?.getText() ?? element.getName();
        if (imported === "Router") routerFactories.add(element.getName());
      }
    }
  }

  return { modules, routerFactories };
}

/** True when an expression creates an Express app or router. */
function createsRouter(
  expression: Expression | undefined,
  modules: Set<string>,
  routerFactories: Set<string>,
): boolean {
  if (!expression || !Node.isCallExpression(expression)) return false;
  const callee = expression.getExpression();
  if (Node.isIdentifier(callee)) {
    return (
      modules.has(callee.getText()) || routerFactories.has(callee.getText())
    );
  }
  if (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "Router"
  ) {
    const owner = callee.getExpression();
    return modules.has(owner.getText()) || requiredModule(owner) === "express";
  }
  // require("express")()
  return requiredModule(callee) === "express";
}

function collectRouters(sourceFile: SourceFile, file: string): FileRouters {
  const { modules, routerFactories } = expressBindings(sourceFile);
  const locals = new Map<string, RouterBinding>();

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const name = declaration.getNameNode();
    if (!Node.isIdentifier(name)) continue;
    const typed = ROUTER_TYPES.test(declaration.getTypeNode()?.getText() ?? "");
    if (
      typed ||
      createsRouter(declaration.getInitializer(), modules, routerFactories)
    ) {
      locals.set(name.getText(), {
        id: `${file}#${name.getText()}`,
        confidence: "high",
      });
    }
  }

  for (const parameter of sourceFile.getDescendantsOfKind(
    SyntaxKind.Parameter,
  )) {
    const name = parameter.getNameNode();
    if (
      Node.isIdentifier(name) &&
      ROUTER_TYPES.test(parameter.getTypeNode()?.getText() ?? "")
    ) {
      locals.set(name.getText(), {
        id: `${file}#${name.getText()}`,
        confidence: "high",
      });
    }
  }

  const exports = new Map<string, string>();
  for (const assignment of sourceFile.getExportAssignments()) {
    const local = locals.get(assignment.getExpression().getText());
    if (local) exports.set("default", local.id);
  }
  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      const local = locals.get(declaration.getName());
      if (local) exports.set(declaration.getName(), local.id);
    }
  }
  for (const binary of sourceFile.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken)
      continue;
    const target = binary.getLeft().getText();
    const local = locals.get(binary.getRight().getText());
    if (!local) continue;
    if (target === "module.exports") exports.set("default", local.id);
    const named = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
    if (named) exports.set(named[1], local.id);
  }

  return { locals, exports };
}

function resolveModule(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** Local names in a file bound to routers exported by other files. */
function importedRouters(
  sourceFile: SourceFile,
  file: string,
  files: ReadonlySet<string>,
  routers: ReadonlyMap<string, FileRouters>,
): Map<string, RouterBinding> {
  const bindings = new Map<string, RouterBinding>();
  const bind = (local: string, target: string | null, exported: string) => {
    const id = target ? routers.get(target)?.exports.get(exported) : undefined;
    if (id) bindings.set(local, { id, confidence: "high" });
  };

  for (const declaration of sourceFile.getImportDeclarations()) {
    const target = resolveModule(
      file,
      declaration.getModuleSpecifierValue(),
      files,
    );
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) bind(defaultImport.getText(), target, "default");
    for (const named of declaration.getNamedImports()) {
      bind(
        named.getAliasNode()?.getText() ?? named.getName(),
        target,
        named.getName(),
      );
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const specifier = requiredModule(declaration.getInitializer());
    const name = declaration.getNameNode();
    if (!specifier || !Node.isIdentifier(name)) continue;
    bind(name.getText(), resolveModule(file, specifier, files), "default");
  }

  return bindings;
}

interface FileScope {
  file: string;
  bindings: Map<string, RouterBinding>;
  /** Every name declared in the file; declared non-routers never fall back. */
  declared: ReadonlySet<string>;
  files: ReadonlySet<string>;
  routers: ReadonlyMap<string, FileRouters>;
}

function declaredNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const kind of [
    SyntaxKind.VariableDeclaration,
    SyntaxKind.Parameter,
    SyntaxKind.ImportSpecifier,
    SyntaxKind.ImportClause,
    SyntaxKind.NamespaceImport,
  ]) {
    for (const node of sourceFile.getDescendantsOfKind(kind)) {
      const name = (
        node as Node & { getNameNode?(): Node | undefined }
      ).getNameNode?.();
      if (name && Node.isIdentifier(name)) names.add(name.getText());
      if (Node.isImportSpecifier(node)) {
        names.add(node.getAliasNode()?.getText() ?? node.getName());
      }
    }
  }
  return names;
}

function resolveReceiver(
  receiver: Expression,
  scope: FileScope,
): RouterBinding | null {
  const text = receiver.getText();
  const bound = Node.isIdentifier(receiver)
    ? scope.bindings.get(text)
    : undefined;
  if (bound) return bound;
  if (Node.isIdentifier(receiver) && scope.declared.has(text)) return null;
  return ROUTER_NAMES.test(text)
    ? { id: `${scope.file}#${text}`, confidence: "low" }
    : null;
}

/** A router passed to use(): a known binding or an inline require(). */
function mountedRouter(argument: Node, scope: FileScope): string | null {
  if (Node.isIdentifier(argument)) {
    return scope.bindings.get(argument.getText())?.id ?? null;
  }
  const specifier = requiredModule(argument);
  if (!specifier) return null;
  const target = resolveModule(scope.file, specifier, scope.files);
  return target
    ? (scope.routers.get(target)?.exports.get("default") ?? null)
    : null;
}

function collectCalls(
  sourceFile: SourceFile,
  scope: FileScope,
): { routes: Route[]; uses: UseCall[]; errorHandler: boolean } {
  const routes: Route[] = [];
  const uses: UseCall[] = [];
  let errorHandler = false;

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const name = expression.getName().toLowerCase();

    if (name === "use") {
      const router = resolveReceiver(expression.getExpression(), scope);
      if (!router) continue;
      const [first, ...rest] = call.getArguments();
      const path = literalText(first);
      const handlers = path === null ? call.getArguments() : rest;
      const middleware: string[] = [];
      const mounts: string[] = [];
      for (const handler of handlers) {
        const mounted = mountedRouter(handler, scope);
        if (mounted) {
          mounts.push(mounted);
          continue;
        }
        middleware.push(handler.getText());
        if (
          Node.isArrowFunction(handler) ||
          Node.isFunctionExpression(handler)
        ) {
          const parameters = handler.getParameters();
          if (
            parameters.length === 4 &&
            /err|error/i.test(parameters[0]?.getName() ?? "")
          ) {
            errorHandler = true;
          }
        } else if (ERROR_NAMES.test(handler.getText())) {
          errorHandler = true;
        }
      }
      uses.push({
        router: router.id,
        file: scope.file,
        position: call.getStart(),
        path: path ?? "",
        middleware,
        mounts,
      });
      continue;
    }

    if (!HTTP_METHODS.has(name)) continue;
    const receiver = expression.getExpression();
    let router: RouterBinding | null;
    let path: string | null;
    let handlers: Node[];

    // router.route("/books").get(list).post(validate, create)
    let chain: Node = receiver;
    while (Node.isCallExpression(chain)) {
      const callee = chain.getExpression();
      if (
        !Node.isPropertyAccessExpression(callee) ||
        !HTTP_METHODS.has(callee.getName().toLowerCase())
      ) {
        break;
      }
      chain = callee.getExpression();
    }
    const routeCall = Node.isCallExpression(chain) ? chain : null;
    const routeAccess = routeCall?.getExpression();
    if (
      routeCall &&
      routeAccess &&
      Node.isPropertyAccessExpression(routeAccess) &&
      routeAccess.getName() === "route"
    ) {
      router = resolveReceiver(routeAccess.getExpression(), scope);
      path = literalText(routeCall.getArguments()[0]);
      handlers = call.getArguments();
    } else {
      router = resolveReceiver(receiver, scope);
      path = literalText(call.getArguments()[0]);
      handlers = call.getArguments().slice(1);
    }
    if (!router || path === null) continue;

    routes.push({
      router: router.id,
      confidence: router.confidence,
      method: name,
      path,
      file: scope.file,
      line: call.getStartLineNumber(),
      position: call.getStart(),
      // The last handler answers the request; the ones before it run first.
      middleware: handlers.slice(0, -1).map((handler) => handler.getText()),
    });
  }

  return { routes, uses, errorHandler };
}

function protects(middleware: string[]): Protection {
  return {
    auth: middleware.some((text) => AUTH_NAMES.test(text)),
    validation: middleware.some((text) => VALIDATION_NAMES.test(text)),
  };
}

function either(left: Protection, right: Protection): Protection {
  return {
    auth: left.auth || right.auth,
    validation: left.validation || right.validation,
  };
}

/**
 * Middleware that every later route of a router passes through: use() calls
 * without a path (or with "/") registered earlier in the same file. A use()
 * with a path only applies under that path, so it never counts here.
 */
function routerMiddlewareBefore(
  uses: UseCall[],
  router: string,
  file: string,
  position: number,
): Protection {
  return protects(
    uses
      .filter(
        (use) =>
          use.router === router &&
          use.file === file &&
          use.position < position &&
          (use.path === "" || use.path === "/"),
      )
      .flatMap((use) => use.middleware),
  );
}

/**
 * Protection a router inherits from where it is mounted. A router mounted in
 * several places is protected only if every mount protects it.
 */
function inherited(
  router: string,
  uses: UseCall[],
  visiting: Set<string>,
): Protection & { prefix: string } {
  const mounts = uses.filter((use) => use.mounts.includes(router));
  if (mounts.length === 0 || visiting.has(router)) {
    return { auth: false, validation: false, prefix: "" };
  }
  visiting.add(router);
  const paths = mounts.map((mount) => {
    const parent = inherited(mount.router, uses, visiting);
    const protection = either(
      either(protects(mount.middleware), parent),
      routerMiddlewareBefore(uses, mount.router, mount.file, mount.position),
    );
    return { ...protection, prefix: `${parent.prefix}${mount.path}` };
  });
  visiting.delete(router);

  return {
    auth: paths.every((path) => path.auth),
    validation: paths.every((path) => path.validation),
    prefix: paths.length === 1 ? paths[0].prefix : "",
  };
}

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

export async function analyzeExpressApi(
  context: ScanContext,
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const sources: Array<{ file: string; sourceFile: SourceFile }> = [];
  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: [
      "**/*.test.{ts,tsx,js,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,mjs,cjs}",
      "**/__tests__/**",
    ],
  })) {
    // A malformed source file should not prevent analysis of the rest.
    const sourceFile = context.getSourceFile(file);
    if (sourceFile) sources.push({ file, sourceFile });
  }

  const files = new Set(sources.map(({ file }) => file));
  const routers = new Map(
    sources.map(({ file, sourceFile }) => [
      file,
      collectRouters(sourceFile, file),
    ]),
  );

  const routes: Route[] = [];
  const uses: UseCall[] = [];
  let errorMiddleware = false;
  for (const { file, sourceFile } of sources) {
    const bindings = new Map([
      ...importedRouters(sourceFile, file, files, routers),
      ...(routers.get(file)?.locals ?? []),
    ]);
    const calls = collectCalls(sourceFile, {
      file,
      bindings,
      declared: declaredNames(sourceFile),
      files,
      routers,
    });
    routes.push(...calls.routes);
    uses.push(...calls.uses);
    errorMiddleware ||= calls.errorHandler;
  }

  if (routes.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-express-routes"),
          message: "No Express app or router endpoints were detected",
        },
      ],
      summary: "No Express endpoints detected",
    };
  }

  const endpoints = routes.map((route) => {
    const parent = inherited(route.router, uses, new Set());
    const protection = either(
      either(protects(route.middleware), parent),
      routerMiddlewareBefore(uses, route.router, route.file, route.position),
    );
    return {
      ...route,
      ...protection,
      path: joinPath(parent.prefix, route.path),
    };
  });

  const mutatingEndpoints = endpoints.filter((endpoint) =>
    MUTATING_METHODS.has(endpoint.method),
  );
  const bodyEndpoints = endpoints.filter((endpoint) =>
    BODY_METHODS.has(endpoint.method),
  );

  for (const endpoint of mutatingEndpoints) {
    if (!endpoint.auth) {
      issues.push({
        ...fromRule("missing-auth-middleware"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no recognizable auth middleware`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Add explicit authentication or authorization middleware",
        confidence: endpoint.confidence,
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!endpoint.validation) {
      issues.push({
        ...fromRule("missing-validation-middleware"),
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no recognizable validation middleware`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Validate request input with a schema or validation middleware",
        confidence: endpoint.confidence,
      });
    }
  }

  if (!errorMiddleware) {
    issues.push({
      ...fromRule("missing-error-middleware"),
      message: "No centralized four-argument Express error middleware detected",
      fix: "Add app.use((error, request, response, next) => { ... })",
    });
  }

  const hasHealthEndpoint = endpoints.some((endpoint) =>
    /(?:^|\/)(?:health|healthz|live|ready|readiness|liveness)(?:\/|$)/i.test(
      endpoint.path,
    ),
  );
  if (!hasHealthEndpoint) {
    issues.push({
      ...fromRule("missing-health-endpoint"),
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Expose a lightweight health endpoint for runtime monitoring",
    });
  }

  const authRate =
    mutatingEndpoints.length === 0
      ? 1
      : mutatingEndpoints.filter((endpoint) => endpoint.auth).length /
        mutatingEndpoints.length;
  const validationRate =
    bodyEndpoints.length === 0
      ? 1
      : bodyEndpoints.filter((endpoint) => endpoint.validation).length /
        bodyEndpoints.length;

  const score = Math.round(
    authRate * 35 +
      validationRate * 30 +
      (errorMiddleware ? 20 : 0) +
      (hasHealthEndpoint ? 15 : 0),
  );

  return {
    name: "API Health",
    score,
    issues,
    summary: `${endpoints.length} Express endpoints across ${sources.length} source files`,
  };
}
