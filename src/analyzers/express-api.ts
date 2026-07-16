import { relative } from "node:path";
import { glob } from "glob";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type SourceFile,
} from "ts-morph";
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
const ROUTER_NAMES = /(?:^|\.)(?:app|api|router)$/i;
const AUTH_NAMES =
  /auth|authenticate|authorize|permission|permit|protect|require.*(?:user|role|login)|jwt/i;
const VALIDATION_NAMES =
  /valid|schema|sanitize|zod|joi|yup|ajv|check(?:body|params|query)/i;
const ERROR_NAMES = /error|exception/i;

interface ExpressEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  hasAuth: boolean;
  hasValidation: boolean;
}

function argumentText(call: CallExpression): string[] {
  const routeArguments = call.getArguments();
  return routeArguments
    .slice(1, Math.max(1, routeArguments.length - 1))
    .map((argument) => argument.getText());
}

function getLiteralPath(call: CallExpression): string | null {
  const firstArgument = call.getArguments()[0];
  if (
    !firstArgument ||
    (!Node.isStringLiteral(firstArgument) &&
      !Node.isNoSubstitutionTemplateLiteral(firstArgument))
  ) {
    return null;
  }

  return firstArgument.getLiteralText();
}

function isExpressReceiver(receiver: string): boolean {
  return ROUTER_NAMES.test(receiver) || /router/i.test(receiver);
}

function findEndpoints(
  sourceFile: SourceFile,
  projectPath: string,
): ExpressEndpoint[] {
  const endpoints: ExpressEndpoint[] = [];
  const file = relative(projectPath, sourceFile.getFilePath()).replace(
    /\\/g,
    "/",
  );

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;

    const method = expression.getName().toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;

    const receiver = expression.getExpression().getText();
    if (!isExpressReceiver(receiver)) continue;

    const path = getLiteralPath(call);
    if (path === null) continue;

    const middleware = argumentText(call);
    endpoints.push({
      method,
      path,
      file,
      line: call.getStartLineNumber(),
      hasAuth: middleware.some((argument) => AUTH_NAMES.test(argument)),
      hasValidation: middleware.some((argument) =>
        VALIDATION_NAMES.test(argument),
      ),
    });
  }

  return endpoints;
}

function hasErrorMiddleware(sourceFiles: SourceFile[]): boolean {
  for (const sourceFile of sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const expression = call.getExpression();
      if (
        !Node.isPropertyAccessExpression(expression) ||
        expression.getName() !== "use" ||
        !isExpressReceiver(expression.getExpression().getText())
      ) {
        continue;
      }

      for (const argument of call.getArguments()) {
        if (
          Node.isArrowFunction(argument) ||
          Node.isFunctionExpression(argument)
        ) {
          const parameters = argument.getParameters();
          if (
            parameters.length === 4 &&
            /err|error/i.test(parameters[0]?.getName() ?? "")
          ) {
            return true;
          }
        } else if (ERROR_NAMES.test(argument.getText())) {
          return true;
        }
      }
    }
  }

  return false;
}

export async function analyzeExpressApi(
  projectPath: string,
  ignore: string[] = ["node_modules/**", "dist/**"],
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const sourcePaths = await glob("**/*.{ts,tsx,js,mjs,cjs}", {
    cwd: projectPath,
    ignore: [
      ...ignore,
      "**/*.test.{ts,tsx,js,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,mjs,cjs}",
      "**/__tests__/**",
    ],
    absolute: true,
  });

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
    },
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFiles: SourceFile[] = [];
  for (const sourcePath of sourcePaths) {
    try {
      sourceFiles.push(project.addSourceFileAtPath(sourcePath));
    } catch {
      // A malformed source file should not prevent analysis of the rest.
    }
  }

  const endpoints = sourceFiles.flatMap((sourceFile) =>
    findEndpoints(sourceFile, projectPath),
  );

  if (endpoints.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          severity: "critical",
          rule: "no-express-routes",
          message: "No Express app or router endpoints were detected",
        },
      ],
      summary: "No Express endpoints detected",
    };
  }

  const mutatingEndpoints = endpoints.filter((endpoint) =>
    MUTATING_METHODS.has(endpoint.method),
  );
  const bodyEndpoints = endpoints.filter((endpoint) =>
    BODY_METHODS.has(endpoint.method),
  );

  for (const endpoint of mutatingEndpoints) {
    if (!endpoint.hasAuth) {
      issues.push({
        severity: "warning",
        rule: "missing-auth-middleware",
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no recognizable auth middleware`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Add explicit authentication or authorization middleware",
      });
    }
  }

  for (const endpoint of bodyEndpoints) {
    if (!endpoint.hasValidation) {
      issues.push({
        severity: "warning",
        rule: "missing-validation-middleware",
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} has no recognizable validation middleware`,
        file: endpoint.file,
        line: endpoint.line,
        fix: "Validate request input with a schema or validation middleware",
      });
    }
  }

  const errorMiddleware = hasErrorMiddleware(sourceFiles);
  if (!errorMiddleware) {
    issues.push({
      severity: "warning",
      rule: "missing-error-middleware",
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
      severity: "info",
      rule: "missing-health-endpoint",
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Expose a lightweight health endpoint for runtime monitoring",
    });
  }

  const authRate =
    mutatingEndpoints.length === 0
      ? 1
      : mutatingEndpoints.filter((endpoint) => endpoint.hasAuth).length /
        mutatingEndpoints.length;
  const validationRate =
    bodyEndpoints.length === 0
      ? 1
      : bodyEndpoints.filter((endpoint) => endpoint.hasValidation).length /
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
    summary: `${endpoints.length} Express endpoints across ${sourceFiles.length} source files`,
  };
}
