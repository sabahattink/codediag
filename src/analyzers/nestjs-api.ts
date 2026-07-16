import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { glob } from "glob";
import { Project, type SourceFile } from "ts-morph";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

const HTTP_DECORATORS = [
  "Get",
  "Post",
  "Put",
  "Delete",
  "Patch",
  "Head",
  "Options",
];

interface EndpointInfo {
  method: string;
  path: string;
  file: string;
  hasGuard: boolean;
  hasDto: boolean;
  hasSwagger: boolean;
  hasReturnType: boolean;
}

export async function analyzeNestjsApi(
  projectPath: string,
  ignore: string[] = ["node_modules/**", "dist/**"],
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const endpoints: EndpointInfo[] = [];

  const controllerFiles = await glob("**/*.controller.ts", {
    cwd: projectPath,
    ignore,
    absolute: true,
  });

  if (controllerFiles.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          severity: "critical",
          rule: "no-controllers",
          message: "No controller files found (*.controller.ts)",
        },
      ],
      summary: "No controllers detected",
    };
  }

  const tsConfigPath = join(projectPath, "tsconfig.json");
  let project: Project;

  try {
    if (existsSync(tsConfigPath)) {
      project = new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true,
      });
    } else {
      project = new Project({ compilerOptions: { strict: true } });
    }
  } catch {
    project = new Project({ compilerOptions: { strict: true } });
  }

  for (const filePath of controllerFiles) {
    let sourceFile: SourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(filePath);
    } catch {
      continue;
    }

    const classes = sourceFile.getClasses();

    for (const cls of classes) {
      const controllerDecorator = cls.getDecorator("Controller");
      if (!controllerDecorator) continue;

      const args = controllerDecorator.getArguments();
      const basePath = args[0]?.getText().replace(/['"]/g, "") || "";
      const classHasGuard = cls
        .getDecorators()
        .some((d) => d.getName() === "UseGuards");

      for (const method of cls.getMethods()) {
        const decorators = method.getDecorators();
        const httpDec = decorators.find((d) =>
          HTTP_DECORATORS.includes(d.getName()),
        );
        if (!httpDec) continue;

        const httpMethod = httpDec.getName().toUpperCase();
        const routePath =
          httpDec.getArguments()[0]?.getText().replace(/['"]/g, "") || "";
        const fullPath =
          `/${basePath}/${routePath}`.replace(/\/+/g, "/").replace(/\/$/, "") ||
          "/";
        const relFile = relative(projectPath, filePath).replace(/\\/g, "/");

        const hasGuard =
          classHasGuard || decorators.some((d) => d.getName() === "UseGuards");

        const hasDto = method.getParameters().some((p) => {
          return (
            p.getDecorators().some((d) => d.getName() === "Body") &&
            p.getTypeNode() !== undefined
          );
        });

        const hasSwagger = decorators.some((d) =>
          [
            "ApiOperation",
            "ApiResponse",
            "ApiTags",
            "ApiBody",
            "ApiBearerAuth",
          ].includes(d.getName()),
        );

        const hasReturnType = method.getReturnTypeNode() !== undefined;

        endpoints.push({
          method: httpMethod,
          path: fullPath,
          file: relFile,
          hasGuard,
          hasDto,
          hasSwagger,
          hasReturnType,
        });

        if (
          !hasGuard &&
          ["POST", "PUT", "DELETE", "PATCH"].includes(httpMethod)
        ) {
          issues.push({
            severity: "warning",
            rule: "missing-guard",
            message: `${httpMethod} ${fullPath} has no auth guard`,
            file: relFile,
            fix: "Add @UseGuards(AuthGuard) to protect this endpoint",
          });
        }

        if (!hasDto && ["POST", "PUT", "PATCH"].includes(httpMethod)) {
          issues.push({
            severity: "warning",
            rule: "missing-dto",
            message: `${httpMethod} ${fullPath} has no typed DTO for request body`,
            file: relFile,
            fix: "Create a DTO class with class-validator decorators",
          });
        }

        if (!hasSwagger) {
          issues.push({
            severity: "info",
            rule: "missing-swagger",
            message: `${httpMethod} ${fullPath} has no Swagger documentation`,
            file: relFile,
            fix: "Add @ApiOperation() and @ApiResponse() decorators",
          });
        }

        if (!hasReturnType) {
          issues.push({
            severity: "info",
            rule: "missing-return-type",
            message: `${httpMethod} ${fullPath} has no explicit return type`,
            file: relFile,
          });
        }
      }
    }
  }

  if (endpoints.length === 0) {
    return {
      name: "API Health",
      score: 50,
      issues: [
        {
          severity: "warning",
          rule: "no-endpoints",
          message: "Controllers found but no HTTP endpoints detected",
        },
      ],
      summary: `${controllerFiles.length} controllers, 0 endpoints`,
    };
  }

  const mutatingEndpoints = endpoints.filter((e) =>
    ["POST", "PUT", "PATCH"].includes(e.method),
  );
  const guardRate =
    endpoints.filter((e) => e.hasGuard).length / endpoints.length;
  const dtoRate =
    mutatingEndpoints.length > 0
      ? mutatingEndpoints.filter((e) => e.hasDto).length /
        mutatingEndpoints.length
      : 1;
  const swaggerRate =
    endpoints.filter((e) => e.hasSwagger).length / endpoints.length;
  const returnTypeRate =
    endpoints.filter((e) => e.hasReturnType).length / endpoints.length;

  const score = Math.round(
    guardRate * 35 + dtoRate * 25 + swaggerRate * 20 + returnTypeRate * 20,
  );

  return {
    name: "API Health",
    score,
    issues,
    summary: `${endpoints.length} endpoints across ${controllerFiles.length} controllers`,
  };
}
