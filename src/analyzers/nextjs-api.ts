import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue } from "../types.js";
import { discoverNextRoutes } from "../discovery/nextjs-routes.js";
import { findFiles, TEST_AND_DECLARATION_GLOBS } from "../utils/files.js";
import { addFiles, createSyntaxProject, needsAuthCheck, needsValidationCheck, rate, routeIssues } from "./api-common.js";

const NEXT_ROUTE_GLOBS = [
  "app/**/route.{ts,tsx,js,jsx,mjs}",
  "src/app/**/route.{ts,tsx,js,jsx,mjs}",
  "pages/api/**/*.{ts,tsx,js,jsx,mjs}",
  "src/pages/api/**/*.{ts,tsx,js,jsx,mjs}",
  "{middleware,proxy}.{ts,js,mjs}",
  "src/{middleware,proxy}.{ts,js,mjs}",
];
const WEIGHTS = { auth: 55, validation: 45 };

/** API Health for Next.js route handlers. Returns null when the app has no API routes. */
export async function analyzeNextjsApi(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult | null> {
  const files = await findFiles(projectPath, NEXT_ROUTE_GLOBS, ctx.ignore, TEST_AND_DECLARATION_GLOBS);
  const project = createSyntaxProject();
  addFiles(project, projectPath, files);

  const routes = discoverNextRoutes(project, projectPath);
  if (routes.length === 0) return null;

  const issues: DiagnosticIssue[] = routes.flatMap((route) =>
    routeIssues(
      route,
      { label: "auth check", fix: "Check the session in the handler (e.g. auth(), getServerSession) or protect the path in middleware" },
      "Validate the parsed body with a schema (e.g. zod safeParse) before using it"
    )
  );

  const authRate = rate(routes.filter(needsAuthCheck), (r) => r.hasAuth);
  const validationRate = rate(routes.filter(needsValidationCheck), (r) => r.hasValidation);
  const score = Math.round(authRate * WEIGHTS.auth + validationRate * WEIGHTS.validation);
  const routeFiles = new Set(routes.map((r) => r.file)).size;

  return { name: "API Health", score, issues, summary: `${routes.length} route handlers across ${routeFiles} files` };
}
