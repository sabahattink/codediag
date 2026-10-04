import {
  type ClassDeclaration,
  type Decorator,
  type MethodDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
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
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const BODY_METHODS = ["POST", "PUT", "PATCH"];
const SWAGGER_CLASS_DECORATORS = ["ApiTags", "ApiBearerAuth"];
const SWAGGER_METHOD_DECORATORS = [
  "ApiOperation",
  "ApiResponse",
  "ApiBody",
  "ApiBearerAuth",
];
/** Metadata keys that conventionally mark a route as intentionally public. */
const PUBLIC_METADATA = /public|skip.?auth|allow.?anonymous|no.?auth/i;
const KNOWN_PUBLIC_DECORATORS = ["Public", "SkipAuth", "AllowAnonymous"];
const NON_DTO_TYPES = new Set(["any", "unknown", "object", "Object"]);
const STRUCTURAL_GENERICS = new Set([
  "Record",
  "Partial",
  "Pick",
  "Omit",
  "Required",
  "Readonly",
  "Map",
]);
const TEST_EXCLUDES = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/{test,tests,__tests__,e2e}/**",
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

/** Project-wide facts that change how individual endpoints are judged. */
interface NestFacts {
  globalGuard: boolean;
  globalValidation: boolean;
  guardDecorators: Set<string>;
  publicDecorators: Set<string>;
  classes: Set<string>;
  structuralTypes: Map<string, "interface" | "type">;
}

/** Names of exported helpers whose body contains a given call. */
function helpersCalling(
  sourceFile: SourceFile,
  matches: (text: string) => boolean,
): string[] {
  const names: string[] = [];
  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (name && matches(declaration.getText())) names.push(name);
  }
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (initializer && matches(initializer.getText())) {
      names.push(declaration.getName());
    }
  }
  return names;
}

function setsPublicMetadata(text: string): boolean {
  for (const match of text.matchAll(/SetMetadata\(\s*([^,)]+)/g)) {
    if (PUBLIC_METADATA.test(match[1])) return true;
  }
  return false;
}

function collectFacts(sourceFiles: SourceFile[]): NestFacts {
  const facts: NestFacts = {
    globalGuard: false,
    globalValidation: false,
    guardDecorators: new Set(["UseGuards"]),
    publicDecorators: new Set(KNOWN_PUBLIC_DECORATORS),
    classes: new Set(),
    structuralTypes: new Map(),
  };

  for (const sourceFile of sourceFiles) {
    for (const name of helpersCalling(sourceFile, (text) =>
      /\bUseGuards\s*\(/.test(text),
    )) {
      facts.guardDecorators.add(name);
    }
    for (const name of helpersCalling(sourceFile, setsPublicMetadata)) {
      facts.publicDecorators.add(name);
    }
    for (const declaration of sourceFile.getClasses()) {
      const name = declaration.getName();
      if (name) facts.classes.add(name);
    }
    for (const declaration of sourceFile.getInterfaces()) {
      facts.structuralTypes.set(declaration.getName(), "interface");
    }
    for (const declaration of sourceFile.getTypeAliases()) {
      facts.structuralTypes.set(declaration.getName(), "type");
    }

    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      if (callee.getName() === "useGlobalGuards") facts.globalGuard = true;
      if (
        callee.getName() === "useGlobalPipes" &&
        /\bValidationPipe\b/.test(call.getText())
      ) {
        facts.globalValidation = true;
      }
    }

    // { provide: APP_GUARD, useClass: JwtGuard } and APP_PIPE equivalents.
    for (const literal of sourceFile.getDescendantsOfKind(
      SyntaxKind.ObjectLiteralExpression,
    )) {
      const provide = literal.getProperty("provide");
      if (!provide || !Node.isPropertyAssignment(provide)) continue;
      const token = provide.getInitializer()?.getText();
      if (token === "APP_GUARD") facts.globalGuard = true;
      if (
        token === "APP_PIPE" &&
        /\bValidationPipe\b/.test(literal.getText())
      ) {
        facts.globalValidation = true;
      }
    }
  }

  return facts;
}

/** The first path from a string, a string array, or `{ path }` argument. */
function decoratorPath(decorator: Decorator | undefined): string {
  let argument: Node | undefined = decorator?.getArguments()[0];
  if (argument && Node.isObjectLiteralExpression(argument)) {
    const path = argument.getProperty("path");
    argument =
      path && Node.isPropertyAssignment(path)
        ? path.getInitializer()
        : undefined;
  }
  if (argument && Node.isArrayLiteralExpression(argument)) {
    argument = argument.getElements()[0];
  }
  if (
    argument &&
    (Node.isStringLiteral(argument) ||
      Node.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return argument.getLiteralText();
  }
  return "";
}

function hasDecorator(
  node: ClassDeclaration | MethodDeclaration,
  names: ReadonlySet<string> | readonly string[],
): boolean {
  const list = names instanceof Set ? names : new Set(names);
  return node
    .getDecorators()
    .some((decorator) => list.has(decorator.getName()));
}

function usesValidationPipe(
  node: ClassDeclaration | MethodDeclaration,
): boolean {
  return node
    .getDecorators()
    .some(
      (decorator) =>
        decorator.getName() === "UsePipes" &&
        /\bValidationPipe\b/.test(decorator.getText()),
    );
}

type BodyCheck =
  | { kind: "none" }
  | { kind: "dto"; validatedClass: boolean; validated: boolean }
  | { kind: "structural"; description: string; interfaceName?: string };

/** Classifies a body parameter's type: only classes can be validated. */
function classifyBodyType(
  typeNode: TypeNode | undefined,
  facts: NestFacts,
): BodyCheck {
  if (!typeNode) {
    return { kind: "structural", description: "an untyped parameter" };
  }
  if (Node.isArrayTypeNode(typeNode)) {
    return classifyBodyType(typeNode.getElementTypeNode(), facts);
  }
  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    if (STRUCTURAL_GENERICS.has(name) || NON_DTO_TYPES.has(name)) {
      return { kind: "structural", description: typeNode.getText() };
    }
    const structural = facts.structuralTypes.get(name);
    if (structural === "interface") {
      return {
        kind: "structural",
        description: `interface ${name}`,
        interfaceName: name,
      };
    }
    if (structural === "type") {
      return { kind: "structural", description: `type ${name}` };
    }
    // Project classes are DTOs; types from packages are assumed to be.
    return {
      kind: "dto",
      validatedClass: facts.classes.has(name),
      validated: false,
    };
  }
  return { kind: "structural", description: typeNode.getText() };
}

function bodyCheck(
  method: MethodDeclaration,
  controller: ClassDeclaration,
  facts: NestFacts,
): BodyCheck {
  const body = method
    .getParameters()
    .find((parameter) =>
      parameter
        .getDecorators()
        .some((decorator) => decorator.getName() === "Body"),
    );
  if (!body) return { kind: "none" };

  const result = classifyBodyType(body.getTypeNode(), facts);
  if (result.kind !== "dto") return result;
  const bodyDecorator = body
    .getDecorators()
    .find((decorator) => decorator.getName() === "Body");
  return {
    ...result,
    validated:
      facts.globalValidation ||
      usesValidationPipe(method) ||
      usesValidationPipe(controller) ||
      /\bValidationPipe\b/.test(bodyDecorator?.getText() ?? ""),
  };
}

function joinPath(base: string, route: string): string {
  return `/${base}/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export async function analyzeNestjsApi(
  context: ScanContext,
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  const endpoints: EndpointInfo[] = [];

  const controllerFiles = context.matchFiles("**/*.controller.ts", {
    exclude: TEST_EXCLUDES,
  });

  if (controllerFiles.length === 0) {
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-controllers"),
          message: "No controller files found (*.controller.ts)",
        },
      ],
      summary: "No controllers detected",
    };
  }

  const facts = collectFacts(
    context
      .matchFiles("**/*.ts", { exclude: [...TEST_EXCLUDES, "**/*.d.ts"] })
      .flatMap((file) => context.getSourceFile(file) ?? []),
  );
  let unvalidatedDto: { file: string; line: number } | undefined;

  for (const relFile of controllerFiles) {
    const sourceFile = context.getSourceFile(relFile);
    if (!sourceFile) continue;

    for (const cls of sourceFile.getClasses()) {
      const controllerDecorator = cls.getDecorator("Controller");
      if (!controllerDecorator) continue;

      const basePath = decoratorPath(controllerDecorator);
      const classHasGuard = hasDecorator(cls, facts.guardDecorators);
      const classIsPublic = hasDecorator(cls, facts.publicDecorators);
      const classHasSwagger = hasDecorator(cls, SWAGGER_CLASS_DECORATORS);

      for (const method of cls.getMethods()) {
        const httpDec = method
          .getDecorators()
          .find((decorator) => HTTP_DECORATORS.includes(decorator.getName()));
        if (!httpDec) continue;

        const httpMethod = httpDec.getName().toUpperCase();
        const fullPath = joinPath(basePath, decoratorPath(httpDec));
        const line = method.getStartLineNumber();

        const hasGuard =
          facts.globalGuard ||
          classHasGuard ||
          hasDecorator(method, facts.guardDecorators);
        const isPublic =
          classIsPublic || hasDecorator(method, facts.publicDecorators);
        const body = bodyCheck(method, cls, facts);
        const hasSwagger =
          classHasSwagger || hasDecorator(method, SWAGGER_METHOD_DECORATORS);
        const hasReturnType = method.getReturnTypeNode() !== undefined;

        endpoints.push({
          method: httpMethod,
          path: fullPath,
          file: relFile,
          hasGuard: hasGuard || isPublic,
          hasDto: body.kind !== "structural",
          hasSwagger,
          hasReturnType,
        });

        if (!hasGuard && !isPublic && MUTATING_METHODS.includes(httpMethod)) {
          issues.push({
            ...fromRule("missing-guard"),
            message: `${httpMethod} ${fullPath} has no auth guard`,
            file: relFile,
            line,
            fix: "Add @UseGuards(AuthGuard), register a global guard, or mark the route @Public() if it is intentionally open",
          });
        }

        if (body.kind === "structural" && BODY_METHODS.includes(httpMethod)) {
          issues.push({
            ...fromRule("missing-dto"),
            message: body.interfaceName
              ? `${httpMethod} ${fullPath} uses ${body.description} for its request body; only classes can be validated at runtime`
              : `${httpMethod} ${fullPath} uses ${body.description} for its request body; declare a DTO class`,
            file: relFile,
            line,
            fix: "Declare a DTO class with class-validator decorators and use it as the @Body() type",
          });
        }

        if (
          body.kind === "dto" &&
          body.validatedClass &&
          !body.validated &&
          !unvalidatedDto
        ) {
          unvalidatedDto = { file: relFile, line };
        }

        if (!hasSwagger) {
          issues.push({
            ...fromRule("missing-swagger"),
            message: `${httpMethod} ${fullPath} has no Swagger documentation`,
            file: relFile,
            line,
            fix: "Add @ApiOperation() and @ApiResponse() decorators",
          });
        }

        if (!hasReturnType) {
          issues.push({
            ...fromRule("missing-return-type"),
            message: `${httpMethod} ${fullPath} has no explicit return type`,
            file: relFile,
            line,
          });
        }
      }
    }
  }

  if (unvalidatedDto) {
    issues.push({
      ...fromRule("dto-not-validated"),
      message:
        "Request DTO classes are used but no ValidationPipe validates them, so their decorators are not enforced",
      ...unvalidatedDto,
      fix: "Register app.useGlobalPipes(new ValidationPipe({ whitelist: true })) or an APP_PIPE provider",
    });
  }

  if (endpoints.length === 0) {
    return {
      name: "API Health",
      score: 50,
      issues: [
        {
          ...fromRule("no-endpoints"),
          message: "Controllers found but no HTTP endpoints detected",
        },
      ],
      summary: `${controllerFiles.length} controllers, 0 endpoints`,
    };
  }

  const mutatingEndpoints = endpoints.filter((e) =>
    BODY_METHODS.includes(e.method),
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
