import { relative } from "path";
import { Node, SyntaxKind, type Project, type SourceFile } from "ts-morph";
import { IN_HANDLER_AUTH, IN_HANDLER_VALIDATION, isAuthMiddleware, joinRoutePath, type RouteInfo } from "../analyzers/api-common.js";
import { readsRequestBody, resolveHandler, type ResolvedHandler } from "./resolve.js";

const NEXT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const APP_ROUTE_FILE = /^(?:src\/)?app\/(?:(.*)\/)?route\.(?:ts|tsx|js|jsx|mjs)$/;
const PAGES_API_FILE = /^(?:src\/)?pages\/(api(?:\/.*)?)\.(?:ts|tsx|js|jsx|mjs)$/;
const MIDDLEWARE_FILE = /^(?:src\/)?(?:middleware|proxy)\.(?:ts|js|mjs)$/;
/** App Router handlers read the body with request.json() / request.formData(). */
const APP_BODY_ACCESS = /\.(?:json|formData)\s*\(/;
/** Auth libraries/helpers commonly used in Next.js middleware. */
const MIDDLEWARE_AUTH = /next-auth|\bauth\b|withAuth|clerkMiddleware|authMiddleware|getToken|jwtVerify|verifyToken|getSession|supabase\.auth|withMiddlewareAuthRequired/i;

interface MiddlewareInfo {
  hasAuth: boolean;
  /** "all" when no matcher is configured (or it cannot be interpreted). */
  matchers: RegExp[] | "all";
}

interface ExportedHandler {
  method: string;
  line: number;
  handler: ResolvedHandler | undefined;
}

/**
 * Converts a Next.js middleware `matcher` (path-to-regexp syntax plus raw regex
 * groups) into a RegExp. Returns null when the pattern is not a valid regex.
 */
export function matcherToRegExp(matcher: string): RegExp | null {
  const source = matcher
    .replace(/\/:\w+\*/g, "(?:/.*)?")
    .replace(/\/:\w+\+/g, "/.+")
    .replace(/\/:\w+\?/g, "(?:/[^/]+)?")
    .replace(/:\w+(?:\([^)]*\))?/g, "[^/]+");
  try {
    return new RegExp(`^${source}/?$`);
  } catch {
    return null;
  }
}

function stringValue(node: Node | undefined): string | undefined {
  return node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralText() : undefined;
}

function parseMatchers(file: SourceFile): RegExp[] | "all" {
  const config = file.getVariableDeclaration("config")?.getInitializer();
  if (!config || !Node.isObjectLiteralExpression(config)) return "all";
  const prop = config.getProperty("matcher");
  if (!prop || !Node.isPropertyAssignment(prop)) return "all";
  const init = prop.getInitializer();

  const entries = Node.isArrayLiteralExpression(init) ? init.getElements() : init ? [init] : [];
  const patterns: string[] = [];
  for (const entry of entries) {
    let value = stringValue(entry);
    if (value === undefined && Node.isObjectLiteralExpression(entry)) {
      const source = entry.getProperty("source");
      value = source && Node.isPropertyAssignment(source) ? stringValue(source.getInitializer()) : undefined;
    }
    if (value === undefined) return "all";
    patterns.push(value);
  }
  const regexes = patterns.map(matcherToRegExp);
  return regexes.every((r): r is RegExp => r !== null) ? regexes : "all";
}

function readMiddleware(files: ReadonlyMap<SourceFile, string>): MiddlewareInfo | undefined {
  for (const [file, rel] of files) {
    if (!MIDDLEWARE_FILE.test(rel)) continue;
    return { hasAuth: MIDDLEWARE_AUTH.test(file.getFullText()), matchers: parseMatchers(file) };
  }
  return undefined;
}

/** "/api/users/[id]" → "/api/users/x" so it can be tested against a matcher. */
function samplePath(path: string): string {
  return path.replace(/\[\[?\.{0,3}[^\]]+\]\]?/g, "x");
}

function middlewareCovers(middleware: MiddlewareInfo | undefined, path: string): boolean {
  if (!middleware?.hasAuth) return false;
  if (middleware.matchers === "all") return true;
  const sample = samplePath(path);
  return middleware.matchers.some((re) => re.test(sample));
}

/** URL path of an App Router route file, or null for private folders. */
function appRoutePath(dir: string | undefined): string | null {
  const segments = (dir ?? "").split("/").filter((s) => s !== "");
  if (segments.some((s) => s.startsWith("_"))) return null;
  return joinRoutePath(...segments.filter((s) => !s.startsWith("(") && !s.startsWith("@")));
}

function appExports(project: Project, file: SourceFile): ExportedHandler[] {
  const out: ExportedHandler[] = [];
  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (fn.hasExportKeyword() && name && NEXT_METHODS.has(name)) {
      out.push({ method: name, line: fn.getStartLineNumber(), handler: { fn, wrapped: false, wrapperText: "" } });
    }
  }
  for (const statement of file.getVariableStatements()) {
    if (!statement.hasExportKeyword()) continue;
    for (const decl of statement.getDeclarations()) {
      const nameNode = decl.getNameNode();
      const init = decl.getInitializer();
      if (Node.isIdentifier(nameNode) && NEXT_METHODS.has(nameNode.getText())) {
        out.push({ method: nameNode.getText(), line: decl.getStartLineNumber(), handler: init ? resolveHandler(project, file, init) : undefined });
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          if (NEXT_METHODS.has(el.getName())) out.push({ method: el.getName(), line: decl.getStartLineNumber(), handler: undefined });
        }
      }
    }
  }
  for (const decl of file.getExportDeclarations()) {
    const reExport = decl.getModuleSpecifierValue() !== undefined;
    for (const spec of decl.getNamedExports()) {
      const exported = spec.getAliasNode()?.getText() ?? spec.getName();
      if (!NEXT_METHODS.has(exported)) continue;
      out.push({
        method: exported,
        line: spec.getStartLineNumber(),
        handler: reExport ? undefined : resolveHandler(project, file, spec.getNameNode()),
      });
    }
  }
  return out;
}

function pagesDefaultExport(project: Project, file: SourceFile): ResolvedHandler | undefined | "none" {
  const fn = file.getFunctions().find((f) => f.hasDefaultKeyword());
  if (fn) return { fn, wrapped: false, wrapperText: "" };
  const assignment = file.getExportAssignments().find((a) => !a.isExportEquals());
  if (!assignment) return "none";
  return resolveHandler(project, file, assignment.getExpression());
}

/** Methods a pages/api handler branches on (req.method === "POST", case "PUT":...), or ["ANY"]. */
function pagesMethods(handler: ResolvedHandler | undefined): string[] {
  if (!handler) return ["ANY"];
  const param = handler.fn.getParameters()[0]?.getName();
  if (!param || !handler.fn.getText().includes(`${param}.method`)) return ["ANY"];
  const methods = new Set<string>();
  for (const literal of handler.fn.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = literal.getLiteralText().toUpperCase();
    if (NEXT_METHODS.has(value)) methods.add(value);
  }
  return methods.size > 0 ? [...methods] : ["ANY"];
}

function toRoute(
  base: { method: string; path: string; file: string; line: number },
  handler: ResolvedHandler | undefined,
  middleware: MiddlewareInfo | undefined,
  bodyAccess: RegExp | undefined
): RouteInfo {
  const text = handler?.fn.getText() ?? "";
  return {
    ...base,
    hasAuth:
      middlewareCovers(middleware, base.path) ||
      (handler !== undefined && handler.wrapped && isAuthMiddleware(handler.wrapperText)) ||
      IN_HANDLER_AUTH.test(text),
    readsBody: handler ? readsRequestBody(handler.fn, bodyAccess) : null,
    hasValidation: IN_HANDLER_VALIDATION.test(text),
    unhandledAsync: false,
  };
}

/**
 * Discovers Next.js API endpoints: App Router `app/**\/route.ts` exported HTTP
 * method handlers and Pages Router `pages/api/**` default handlers, and marks
 * those covered by an auth middleware (middleware.ts / proxy.ts matcher).
 */
export function discoverNextRoutes(project: Project, rootDir: string): RouteInfo[] {
  const files = new Map<SourceFile, string>();
  for (const file of project.getSourceFiles()) {
    files.set(file, relative(rootDir, file.getFilePath()).replace(/\\/g, "/"));
  }
  const middleware = readMiddleware(files);
  const routes: RouteInfo[] = [];

  for (const [file, rel] of files) {
    const app = APP_ROUTE_FILE.exec(rel);
    if (app) {
      const path = appRoutePath(app[1]);
      if (path === null) continue;
      for (const exp of appExports(project, file)) {
        routes.push(toRoute({ method: exp.method, path, file: rel, line: exp.line }, exp.handler, middleware, APP_BODY_ACCESS));
      }
      continue;
    }

    const pages = PAGES_API_FILE.exec(rel);
    if (pages?.[1]) {
      const handler = pagesDefaultExport(project, file);
      if (handler === "none") continue;
      const path = joinRoutePath(pages[1].replace(/(?:^|\/)index$/, ""));
      const line = handler?.fn.getStartLineNumber() ?? 1;
      for (const method of pagesMethods(handler)) {
        routes.push(toRoute({ method, path, file: rel, line }, handler, middleware, undefined));
      }
    }
  }
  return routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method));
}
