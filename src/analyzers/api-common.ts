import { readFileSync } from "fs";
import { join } from "path";
import { Project } from "ts-morph";
import type { DiagnosticIssue } from "../types.js";

/** Methods that change state and should be authenticated. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Methods that carry a request body that should be validated. */
export const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/**
 * Path segments of routes that are public by design (sign-in flows, OAuth
 * callbacks, webhooks verified by signature, health probes). Mutating routes
 * under these segments are not reported as missing auth.
 */
const PUBLIC_SEGMENTS: ReadonlySet<string> = new Set([
  "login", "logout", "signin", "sign-in", "signout", "sign-out", "signup", "sign-up", "register",
  "auth", "oauth", "callback", "webhook", "webhooks", "forgot-password", "reset-password",
  "verify-email", "health", "healthz",
]);

export function isPublicByDesign(path: string): boolean {
  return path
    .toLowerCase()
    .split("/")
    .some((segment) => PUBLIC_SEGMENTS.has(segment));
}

/** Names of middleware / wrappers that authenticate or authorize a request. */
export const AUTH_MIDDLEWARE = /auth|protect|guard|jwt|passport|clerk|verify(?:Token|User|Jwt|Session)|require(?:User|Login|Session|Role|Admin)|ensure(?:User|LoggedIn|Authenticated)|isLoggedIn|loggedIn|signedIn|isAdmin|hasRole|permission/i;
/** Setup calls that mention auth libraries but do not protect anything. */
const NOT_AUTH_MIDDLEWARE = /passport\.(?:initialize|session)\s*\(/;

export function isAuthMiddleware(text: string): boolean {
  return AUTH_MIDDLEWARE.test(text) && !NOT_AUTH_MIDDLEWARE.test(text);
}

/** Calls inside a handler that establish who the caller is. */
export const IN_HANDLER_AUTH = /\b(?:auth|getServerSession|getSession|getToken|currentUser|getUser|getAuth|requireAuth|requireUser|verifyToken|verifyJwt|jwtVerify|validateSession|protect)\s*\(|['"]authorization['"]/i;

/** Validation middleware: express-validator, celebrate, zod/joi/yup wrappers, custom validate*(). */
export const VALIDATION_MIDDLEWARE = /valid|schema|celebrate|zod|joi|yup|sanitiz|\b(?:body|check|param|query)\s*\(/i;

/** Schema validation performed inside a handler. */
export const IN_HANDLER_VALIDATION = /(?<!\b(?:JSON|Date|path|url|qs|querystring))\.(?:safeParse|safeParseAsync|parseAsync|parse|validate|validateAsync|validateSync)\s*\(|\bvalidationResult\s*\(|\bvalidate\w*\s*\(|\bplainToInstance\s*\(/;

/** A discovered HTTP endpoint plus the facts the API Health checks need. */
export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  hasAuth: boolean;
  /** Whether the handler reads the request body; null when the handler could not be resolved. */
  readsBody: boolean | null;
  hasValidation: boolean;
  /** Express 4 only: async handler whose rejections are not caught. */
  unhandledAsync: boolean;
}

/** Joins route path fragments into "/a/b/c" (no duplicate or trailing slashes). */
export function joinRoutePath(...parts: readonly string[]): string {
  const joined = `/${parts.filter((p) => p !== "").join("/")}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/** Fraction of `items` matching `predicate`; 1 when there is nothing to measure. */
export function rate<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.length === 0 ? 1 : items.filter(predicate).length / items.length;
}

/** A ts-morph project used for syntax analysis only (no type checking, no lib loading). */
export function createSyntaxProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true },
  });
}

/** Adds project-relative files to a ts-morph project, skipping unreadable ones. */
export function addFiles(project: Project, projectPath: string, files: readonly string[]): void {
  for (const file of files) {
    try {
      const abs = join(projectPath, file);
      project.createSourceFile(abs, readFileSync(abs, "utf-8"), { overwrite: true });
    } catch { /* unreadable file: skip */ }
  }
}

/** Standard API Health issues for auth and body validation (shared by Express and Next.js). */
export function routeIssues(route: RouteInfo, auth: { label: string; fix: string }, validationFix: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const where = { file: route.file, line: route.line };
  if (needsAuthCheck(route) && !route.hasAuth) {
    issues.push({ severity: "warning", rule: "missing-auth", message: `${route.method} ${route.path} has no ${auth.label}`, ...where, fix: auth.fix });
  }
  if (needsValidationCheck(route) && !route.hasValidation) {
    issues.push({ severity: "warning", rule: "missing-validation", message: `${route.method} ${route.path} reads the request body without validation`, ...where, fix: validationFix });
  }
  return issues;
}

/** Mutating routes, plus method-agnostic handlers that read a body, excluding public-by-design paths. */
export function needsAuthCheck(route: RouteInfo): boolean {
  const mutating = MUTATING_METHODS.has(route.method) || (route.method === "ANY" && route.readsBody === true);
  return mutating && !isPublicByDesign(route.path);
}

export function needsValidationCheck(route: RouteInfo): boolean {
  return (BODY_METHODS.has(route.method) || route.method === "ANY") && route.readsBody === true;
}
