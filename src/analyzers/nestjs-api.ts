import { readFileSync } from "fs";
import { join } from "path";
import { Node, type ClassDeclaration, type Decorator, type SourceFile } from "ts-morph";
import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue } from "../types.js";
import { findFiles, TEST_AND_DECLARATION_GLOBS } from "../utils/files.js";
import { addFiles, createSyntaxProject, isPublicByDesign, joinRoutePath } from "./api-common.js";

const HTTP_DECORATORS = ["Get", "Post", "Put", "Delete", "Patch", "Head", "Options"];
const SWAGGER_DECORATORS = ["ApiOperation", "ApiResponse", "ApiTags", "ApiBody", "ApiBearerAuth"];
/** Common decorators that mark a route as intentionally public when a global guard is used. */
const PUBLIC_DECORATORS = ["Public", "IsPublic", "SkipAuth", "AllowAnonymous", "Anonymous"];
/** Body parameter types that do not describe the payload. */
const UNTYPED_BODY = /^(?:any|unknown|object|Object|Record<.*>|\{\s*\[.*\]\s*:\s*(?:any|unknown)\s*;?\s*\})$/s;
const GLOBAL_GUARD = /\bAPP_GUARD\b|\.useGlobalGuards\s*\(/;

interface EndpointInfo {
  method: string;
  path: string;
  file: string;
  hasGuard: boolean;
  hasDto: boolean;
  hasSwagger: boolean;
  hasReturnType: boolean;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

/** Route path from the first decorator argument: '...', `...`, or { path: '...' }. */
function decoratorPath(decorator: Decorator): string {
  const arg = decorator.getArguments()[0];
  if (!arg) return "";
  if (Node.isObjectLiteralExpression(arg)) {
    const path = arg.getProperty("path");
    return path && Node.isPropertyAssignment(path) ? stripQuotes(path.getInitializer()?.getText() ?? "") : "";
  }
  return stripQuotes(arg.getText());
}

function hasDecorator(decorators: readonly Decorator[], names: readonly string[]): boolean {
  return decorators.some((d) => names.includes(d.getName()));
}

/** True when a guard is registered globally (APP_GUARD provider or app.useGlobalGuards). */
async function hasGlobalGuard(projectPath: string, ctx: AnalyzerContext): Promise<boolean> {
  const files = await findFiles(projectPath, "**/*.ts", ctx.ignore, TEST_AND_DECLARATION_GLOBS);
  return files.some((file) => {
    try {
      return GLOBAL_GUARD.test(readFileSync(join(projectPath, file), "utf-8"));
    } catch {
      return false;
    }
  });
}

function analyzeController(cls: ClassDeclaration, file: string, globalGuard: boolean, issues: DiagnosticIssue[]): EndpointInfo[] {
  const controllerDecorator = cls.getDecorator("Controller");
  if (!controllerDecorator) return [];

  const endpoints: EndpointInfo[] = [];
  const basePath = decoratorPath(controllerDecorator);
  const classDecorators = cls.getDecorators();
  const classHasGuard = hasDecorator(classDecorators, ["UseGuards"]);
  const classIsPublic = hasDecorator(classDecorators, PUBLIC_DECORATORS);

  for (const method of cls.getMethods()) {
    const decorators = method.getDecorators();
    const httpDec = decorators.find((d) => HTTP_DECORATORS.includes(d.getName()));
    if (!httpDec) continue;

    const httpMethod = httpDec.getName().toUpperCase();
    const fullPath = joinRoutePath(basePath, decoratorPath(httpDec));
    const line = method.getStartLineNumber();
    const where = { file, line };

    const isPublic = classIsPublic || hasDecorator(decorators, PUBLIC_DECORATORS) || isPublicByDesign(fullPath);
    const hasGuard = globalGuard || classHasGuard || hasDecorator(decorators, ["UseGuards"]) || isPublic;
    const hasDto = method.getParameters().some((p) => {
      const typeNode = p.getTypeNode();
      return p.getDecorators().some((d) => d.getName() === "Body") && typeNode !== undefined && !UNTYPED_BODY.test(typeNode.getText());
    });
    const hasSwagger = hasDecorator(decorators, SWAGGER_DECORATORS) || hasDecorator(classDecorators, SWAGGER_DECORATORS);
    const hasReturnType = method.getReturnTypeNode() !== undefined;

    endpoints.push({ method: httpMethod, path: fullPath, file, hasGuard, hasDto, hasSwagger, hasReturnType });

    if (!hasGuard && ["POST", "PUT", "DELETE", "PATCH"].includes(httpMethod)) {
      issues.push({ severity: "warning", rule: "missing-guard", message: `${httpMethod} ${fullPath} has no auth guard`, ...where, fix: "Add @UseGuards(AuthGuard) to protect this endpoint" });
    }
    if (!hasDto && ["POST", "PUT", "PATCH"].includes(httpMethod)) {
      issues.push({ severity: "warning", rule: "missing-dto", message: `${httpMethod} ${fullPath} has no typed DTO for request body`, ...where, fix: "Create a DTO class with class-validator decorators" });
    }
    if (!hasSwagger) {
      issues.push({ severity: "info", rule: "missing-swagger", message: `${httpMethod} ${fullPath} has no Swagger documentation`, ...where, fix: "Add @ApiOperation() and @ApiResponse() decorators" });
    }
    if (!hasReturnType) {
      issues.push({ severity: "info", rule: "missing-return-type", message: `${httpMethod} ${fullPath} has no explicit return type`, ...where });
    }
  }
  return endpoints;
}

export async function analyzeNestjsApi(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const endpoints: EndpointInfo[] = [];

  const controllerFiles = await findFiles(projectPath, "**/*.controller.ts", ctx.ignore);
  if (controllerFiles.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [{ severity: "critical", rule: "no-controllers", message: "No controller files found (*.controller.ts)" }],
      summary: "No controllers detected",
    };
  }

  const globalGuard = await hasGlobalGuard(projectPath, ctx);
  const project = createSyntaxProject();
  addFiles(project, projectPath, controllerFiles);

  controllerFiles.forEach((file) => {
    const sourceFile: SourceFile | undefined = project.getSourceFile(join(projectPath, file));
    if (!sourceFile) return;
    for (const cls of sourceFile.getClasses()) {
      endpoints.push(...analyzeController(cls, file, globalGuard, issues));
    }
  });

  if (endpoints.length === 0) {
    return {
      name: "API Health",
      score: 50,
      issues: [{ severity: "warning", rule: "no-endpoints", message: "Controllers found but no HTTP endpoints detected" }],
      summary: `${controllerFiles.length} controllers, 0 endpoints`,
    };
  }

  const mutatingEndpoints = endpoints.filter((e) => ["POST", "PUT", "PATCH"].includes(e.method));
  const guardRate = endpoints.filter((e) => e.hasGuard).length / endpoints.length;
  const dtoRate = mutatingEndpoints.length > 0
    ? mutatingEndpoints.filter((e) => e.hasDto).length / mutatingEndpoints.length
    : 1;
  const swaggerRate = endpoints.filter((e) => e.hasSwagger).length / endpoints.length;
  const returnTypeRate = endpoints.filter((e) => e.hasReturnType).length / endpoints.length;

  const score = Math.round(guardRate * 35 + dtoRate * 25 + swaggerRate * 20 + returnTypeRate * 20);

  return {
    name: "API Health",
    score,
    issues,
    summary: `${endpoints.length} endpoints across ${controllerFiles.length} controllers${globalGuard ? " (global guard)" : ""}`,
  };
}
