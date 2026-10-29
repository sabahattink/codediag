import { relative } from "path";
import { Node, SyntaxKind, type CallExpression, type Project, type SourceFile } from "ts-morph";
import {
  IN_HANDLER_VALIDATION,
  VALIDATION_MIDDLEWARE,
  isAuthMiddleware,
  joinRoutePath,
  type RouteInfo,
} from "../analyzers/api-common.js";
import {
  hasErrorHandling,
  readsRequestBody,
  requireSpecifier,
  resolveExpression,
  resolveHandler,
  resolveIdentifierNode,
} from "./resolve.js";

const HTTP_METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const ROUTER_PARAM_TYPE = /^(?:express\.)?(?:Express|Router|Application|IRouter)$/;
/** Identifiers that name routers, not middleware (e.g. an unresolved `authRoutes`). */
const ROUTER_LIKE_NAME = /(?:router|routes)$/i;

export interface ExpressDiscoveryOptions {
  /** Express 5+ or express-async-errors: rejected promises reach the error handler. */
  asyncErrorsHandled: boolean;
}

interface AuthUse {
  prefix: string;
  file: SourceFile;
  pos: number;
}

interface RouterNode {
  authUses: AuthUse[];
}

interface Mount {
  parent: RouterNode;
  child: RouterNode;
  prefix: string;
  authBefore: boolean;
  file: SourceFile;
  pos: number;
}

interface RawRoute {
  router: RouterNode;
  method: string;
  path: string;
  file: SourceFile;
  call: CallExpression;
  handlers: Node[];
}

interface Effective {
  prefix: string;
  auth: boolean;
}

/** Names that create an app or router in this file: express(), express.Router(), Router(), plus local aliases. */
function routerFactories(file: SourceFile): Set<string> {
  const names = new Set(["express", "express.Router", "Router"]);
  const addDefault = (name: string): void => {
    names.add(name);
    names.add(`${name}.Router`);
  };
  for (const imp of file.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== "express") continue;
    const def = imp.getDefaultImport()?.getText();
    if (def) addDefault(def);
    const ns = imp.getNamespaceImport()?.getText();
    if (ns) { names.add(`${ns}.default`); names.add(`${ns}.Router`); }
    for (const named of imp.getNamedImports()) {
      if (named.getName() === "Router") names.add(named.getAliasNode()?.getText() ?? "Router");
    }
  }
  for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (requireSpecifier(decl.getInitializer()) !== "express") continue;
    const nameNode = decl.getNameNode();
    if (Node.isIdentifier(nameNode)) addDefault(nameNode.getText());
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const el of nameNode.getElements()) {
        if ((el.getPropertyNameNode()?.getText() ?? el.getName()) === "Router") names.add(el.getName());
      }
    }
  }
  return names;
}

function collectRouters(project: Project, routers: Map<Node, RouterNode>): void {
  for (const file of project.getSourceFiles()) {
    const factories = routerFactories(file);
    for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      if ((Node.isCallExpression(init) || Node.isNewExpression(init)) && factories.has(init.getExpression().getText())) {
        routers.set(decl, { authUses: [] });
      }
    }
    for (const param of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
      const type = param.getTypeNode()?.getText();
      if (type && ROUTER_PARAM_TYPE.test(type)) routers.set(param, { authUses: [] });
    }
  }
}

function pathText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isTemplateExpression(node)) return node.getText().slice(1, -1);
  if (Node.isRegularExpressionLiteral(node)) return node.getText();
  if (Node.isArrayLiteralExpression(node)) return node.getElements().map((e) => pathText(e) ?? e.getText()).join(",");
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) return `{${node.getText()}}`;
  return undefined;
}

function literalPrefix(node: Node | undefined): string | undefined {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralText();
  return undefined;
}

function flatten(args: readonly Node[]): Node[] {
  return args.flatMap((a) => (Node.isArrayLiteralExpression(a) ? a.getElements() : [a]));
}

function pathHasPrefix(path: string, prefix: string): boolean {
  const p = joinRoutePath(path);
  const pre = joinRoutePath(prefix);
  return pre === "/" || p === pre || p.startsWith(`${pre}/`);
}

class ExpressDiscovery {
  private readonly routers = new Map<Node, RouterNode>();
  private readonly mounts: Mount[] = [];
  private readonly rawRoutes: RawRoute[] = [];
  private readonly memo = new Map<RouterNode, Effective>();

  constructor(
    private readonly project: Project,
    private readonly rootDir: string,
    private readonly options: ExpressDiscoveryOptions
  ) {}

  run(): RouteInfo[] {
    const files = this.project.getSourceFiles();
    collectRouters(this.project, this.routers);
    for (const file of files) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) this.visitCall(file, call);
    }
    return this.rawRoutes
      .map((raw) => this.toRouteInfo(raw))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private routerOf(node: Node): RouterNode | undefined {
    const resolved = Node.isIdentifier(node)
      ? resolveIdentifierNode(this.project, node)
      : resolveExpression(this.project, node.getSourceFile(), node);
    return resolved?.kind === "node" ? this.routers.get(resolved.node) : undefined;
  }

  private visitCall(file: SourceFile, call: CallExpression): void {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const name = expr.getName();
    const target = expr.getExpression();

    if (name === "use" && Node.isIdentifier(target)) {
      const router = this.routerOf(target);
      if (router) this.visitUse(file, call, router);
      return;
    }
    if (!HTTP_METHODS.has(name)) return;

    if (Node.isIdentifier(target)) {
      const router = this.routerOf(target);
      const args = call.getArguments();
      const path = pathText(args[0]);
      if (!router || args.length < 2 || path === undefined) return;
      this.rawRoutes.push({ router, method: name.toUpperCase(), path, file, call, handlers: args.slice(1) });
      return;
    }

    // router.route("/path").get(h).post(h)
    let current: Node = target;
    while (Node.isCallExpression(current)) {
      const inner = current.getExpression();
      if (!Node.isPropertyAccessExpression(inner)) return;
      if (inner.getName() === "route") {
        const receiver = inner.getExpression();
        const router = Node.isIdentifier(receiver) ? this.routerOf(receiver) : undefined;
        const path = pathText(current.getArguments()[0]);
        if (router && path !== undefined) {
          this.rawRoutes.push({ router, method: name.toUpperCase(), path, file, call, handlers: call.getArguments() });
        }
        return;
      }
      if (!HTTP_METHODS.has(inner.getName())) return;
      current = inner.getExpression();
    }
  }

  private visitUse(file: SourceFile, call: CallExpression, router: RouterNode): void {
    const args = call.getArguments();
    const prefix = literalPrefix(args[0]);
    const rest = flatten(prefix === undefined ? args : args.slice(1));
    let authSeen = false;
    for (const arg of rest) {
      const child = this.routerOf(arg);
      if (child) {
        this.mounts.push({ parent: router, child, prefix: prefix ?? "", authBefore: authSeen, file, pos: call.getStart() });
        continue;
      }
      if (isAuthMiddleware(arg.getText()) && !(Node.isIdentifier(arg) && ROUTER_LIKE_NAME.test(arg.getText()))) {
        authSeen = true;
        router.authUses.push({ prefix: prefix ?? "", file, pos: call.getStart() });
      }
    }
  }

  /** Router-level `use(auth)` registered before `pos` (same file) whose prefix covers `path`. */
  private authUseApplies(router: RouterNode, file: SourceFile, pos: number, path: string): boolean {
    return router.authUses.some((u) => (u.file !== file || u.pos < pos) && pathHasPrefix(path, u.prefix));
  }

  /** Mount prefix and inherited auth of a router (first mount wins; cycles terminate). */
  private effective(router: RouterNode, visiting: Set<RouterNode> = new Set()): Effective {
    const cached = this.memo.get(router);
    if (cached) return cached;
    const mount = this.mounts.find((m) => m.child === router);
    if (!mount || visiting.has(router)) return { prefix: "", auth: false };

    visiting.add(router);
    const parent = this.effective(mount.parent, visiting);
    visiting.delete(router);
    const result: Effective = {
      prefix: joinRoutePath(parent.prefix, mount.prefix),
      auth: parent.auth || mount.authBefore || this.authUseApplies(mount.parent, mount.file, mount.pos, mount.prefix),
    };
    this.memo.set(router, result);
    return result;
  }

  private toRouteInfo(raw: RawRoute): RouteInfo {
    const handlers = flatten(raw.handlers);
    const last = handlers[handlers.length - 1];
    const middlewares = handlers.slice(0, -1);
    const effective = this.effective(raw.router);
    const handler = last ? resolveHandler(this.project, raw.file, last) : undefined;

    const hasAuth =
      effective.auth ||
      this.authUseApplies(raw.router, raw.file, raw.call.getStart(), raw.path) ||
      middlewares.some((m) => isAuthMiddleware(m.getText()));
    const hasValidation =
      middlewares.some((m) => VALIDATION_MIDDLEWARE.test(m.getText())) ||
      (handler !== undefined && IN_HANDLER_VALIDATION.test(handler.fn.getText()));
    const unhandledAsync =
      !this.options.asyncErrorsHandled &&
      handler !== undefined &&
      !handler.wrapped &&
      handler.fn.isAsync() &&
      !hasErrorHandling(handler.fn);

    return {
      method: raw.method,
      path: joinRoutePath(effective.prefix, raw.path),
      file: relative(this.rootDir, raw.file.getFilePath()).replace(/\\/g, "/"),
      line: raw.call.getStartLineNumber(),
      hasAuth,
      readsBody: handler ? readsRequestBody(handler.fn) : null,
      hasValidation,
      unhandledAsync,
    };
  }
}

/**
 * Discovers Express routes in every source file of `project`: `app/router.<method>(path, ...handlers)`,
 * `router.route(path).<method>(...)`, routers mounted with `use(prefix, [auth,] router)` across
 * modules, and router-level `use(auth)` middleware in registration order.
 */
export function discoverExpressRoutes(project: Project, rootDir: string, options: ExpressDiscoveryOptions): RouteInfo[] {
  return new ExpressDiscovery(project, rootDir, options).run();
}
