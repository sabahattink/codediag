import { readFileSync } from "fs";
import { join } from "path";
import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue } from "../types.js";
import { discoverExpressRoutes } from "../discovery/express-routes.js";
import { findFiles, TEST_AND_DECLARATION_GLOBS } from "../utils/files.js";
import { allDependencies, hasAnyDependency, majorVersion, readPackageJsonOrNull } from "../utils/package-json.js";
import { createSyntaxProject, needsAuthCheck, needsValidationCheck, rate, routeIssues } from "./api-common.js";

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";
/** Only files that mention Express are parsed up front; handlers elsewhere are loaded on demand. */
const MENTIONS_EXPRESS = /\b(?:express|Router)\b/;
const WEIGHTS = { auth: 45, validation: 35, asyncErrors: 20 };

/**
 * Express 5 forwards rejected promises to the error handler; so does Express 4
 * with express-async-errors. Unknown versions ("latest", "*") are not flagged.
 */
function asyncErrorsHandled(projectPath: string): boolean {
  const pkg = readPackageJsonOrNull(projectPath);
  if (hasAnyDependency(pkg, ["express-async-errors"])) return true;
  const major = majorVersion(allDependencies(pkg)["express"]);
  return major === null || major >= 5;
}

/** API Health for Express. Returns null when no routes are found (analyzer not applicable). */
export async function analyzeExpressApi(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult | null> {
  const files = await findFiles(projectPath, SOURCE_GLOB, ctx.ignore, TEST_AND_DECLARATION_GLOBS);
  const project = createSyntaxProject();
  for (const file of files) {
    const abs = join(projectPath, file);
    try {
      const text = readFileSync(abs, "utf-8");
      if (MENTIONS_EXPRESS.test(text)) project.createSourceFile(abs, text, { overwrite: true });
    } catch { /* unreadable file: skip */ }
  }

  const routes = discoverExpressRoutes(project, projectPath, { asyncErrorsHandled: asyncErrorsHandled(projectPath) });
  if (routes.length === 0) return null;

  const issues: DiagnosticIssue[] = [];
  for (const route of routes) {
    issues.push(...routeIssues(
      route,
      { label: "auth middleware", fix: "Add authentication middleware (e.g. requireAuth, passport.authenticate) to the route or its router" },
      "Validate req.body with zod, joi or express-validator before using it"
    ));
    if (route.unhandledAsync) {
      issues.push({
        severity: "warning",
        rule: "unhandled-async",
        message: `${route.method} ${route.path} has an async handler without error handling`,
        file: route.file,
        line: route.line,
        fix: "Express 4 does not catch rejected promises: add try/catch, wrap with an async handler, or upgrade to Express 5",
      });
    }
  }

  const authRate = rate(routes.filter(needsAuthCheck), (r) => r.hasAuth);
  const validationRate = rate(routes.filter(needsValidationCheck), (r) => r.hasValidation);
  const asyncRate = rate(routes, (r) => !r.unhandledAsync);
  const score = Math.round(authRate * WEIGHTS.auth + validationRate * WEIGHTS.validation + asyncRate * WEIGHTS.asyncErrors);
  const routeFiles = new Set(routes.map((r) => r.file)).size;

  return { name: "API Health", score, issues, summary: `${routes.length} routes across ${routeFiles} files` };
}
