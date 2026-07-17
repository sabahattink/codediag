import { relative } from "node:path";
import { glob } from "glob";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type SourceFile,
} from "ts-morph";
import type { DiagnosticIssue } from "../types.js";

const RUNTIME_IGNORES = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const COMMAND_FUNCTIONS = new Set(["exec", "execSync"]);
const SQL_METHODS = new Set([
  "$executeRawUnsafe",
  "$queryRawUnsafe",
  "execute",
  "query",
  "raw",
]);
const SQL_RECEIVER =
  /(?:^|\.)(?:client|connection|database|db|entityManager|knex|pool|prisma|queryRunner|sql)$/i;
const REQUEST_DATA =
  /\b(?:req(?:uest)?|ctx)\s*(?:\.|\[)|\bprocess\s*\.\s*argv\b|\b(?:body|params|query)\s*(?:\.|\[)/i;

interface CommandBindings {
  functions: Set<string>;
  namespaces: Set<string>;
}

function sourceLocation(
  sourceFile: SourceFile,
  projectPath: string,
  line: number,
) {
  return {
    file: relative(projectPath, sourceFile.getFilePath()).replace(/\\/g, "/"),
    line,
  };
}

function isModuleCall(expression: Expression, modules: Set<string>): boolean {
  if (!Node.isCallExpression(expression)) return false;
  if (expression.getExpression().getText() !== "require") return false;
  const moduleArgument = expression.getArguments()[0];
  return (
    Node.isStringLiteral(moduleArgument) &&
    modules.has(moduleArgument.getLiteralText())
  );
}

function commandBindings(sourceFile: SourceFile): CommandBindings {
  const functions = new Set<string>();
  const namespaces = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!CHILD_PROCESS_MODULES.has(declaration.getModuleSpecifierValue())) {
      continue;
    }

    const namespace = declaration.getNamespaceImport();
    if (namespace) namespaces.add(namespace.getText());

    for (const namedImport of declaration.getNamedImports()) {
      if (!COMMAND_FUNCTIONS.has(namedImport.getName())) continue;
      functions.add(
        namedImport.getAliasNode()?.getText() ?? namedImport.getName(),
      );
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !isModuleCall(initializer, CHILD_PROCESS_MODULES)) {
      continue;
    }

    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      namespaces.add(nameNode.getText());
      continue;
    }
    if (!Node.isObjectBindingPattern(nameNode)) continue;

    for (const element of nameNode.getElements()) {
      const importedName =
        element.getPropertyNameNode()?.getText() ?? element.getName();
      if (COMMAND_FUNCTIONS.has(importedName)) functions.add(element.getName());
    }
  }

  return { functions, namespaces };
}

function commandCall(call: CallExpression, bindings: CommandBindings): boolean {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) {
    return bindings.functions.has(expression.getText());
  }
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (
    bindings.namespaces.has(expression.getExpression().getText()) &&
    COMMAND_FUNCTIONS.has(expression.getName())
  ) {
    return true;
  }
  return (
    COMMAND_FUNCTIONS.has(expression.getName()) &&
    isModuleCall(expression.getExpression(), CHILD_PROCESS_MODULES)
  );
}

function isStaticString(node: Node | undefined): boolean {
  return Boolean(
    node &&
      (Node.isStringLiteral(node) ||
        Node.isNoSubstitutionTemplateLiteral(node)),
  );
}

function isDynamicSqlCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (!SQL_METHODS.has(expression.getName())) return false;
  if (
    !expression.getName().endsWith("Unsafe") &&
    !SQL_RECEIVER.test(expression.getExpression().getText())
  ) {
    return false;
  }

  const query = call.getArguments()[0];
  if (!query || isStaticString(query)) return false;
  return true;
}

function severityForDynamicInput(text: string): DiagnosticIssue["severity"] {
  return REQUEST_DATA.test(text) ? "critical" : "warning";
}

function inspectSourceFile(
  sourceFile: SourceFile,
  projectPath: string,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const bindings = commandBindings(sourceFile);

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    const isEval =
      (Node.isIdentifier(expression) && expression.getText() === "eval") ||
      (Node.isPropertyAccessExpression(expression) &&
        expression.getExpression().getText() === "globalThis" &&
        expression.getName() === "eval");

    if (isEval) {
      issues.push({
        severity: "critical",
        rule: "unsafe-dynamic-code",
        message: "Runtime code execution uses eval()",
        ...sourceLocation(sourceFile, projectPath, call.getStartLineNumber()),
        fix: "Replace eval() with explicit parsing, dispatch, or a sandbox designed for untrusted code",
      });
      continue;
    }

    if (commandCall(call, bindings)) {
      const command = call.getArguments()[0];
      if (command && !isStaticString(command)) {
        issues.push({
          severity: severityForDynamicInput(command.getText()),
          rule: "dynamic-command-execution",
          message: "Shell execution receives a non-literal command",
          ...sourceLocation(sourceFile, projectPath, call.getStartLineNumber()),
          fix: "Avoid a shell; use execFile or spawn with a fixed executable and validated argument array",
        });
      }
    }

    if (isDynamicSqlCall(call)) {
      const query = call.getArguments()[0];
      issues.push({
        severity: severityForDynamicInput(query?.getText() ?? ""),
        rule: "dynamic-sql-query",
        message: "SQL execution uses a dynamically constructed query",
        ...sourceLocation(sourceFile, projectPath, call.getStartLineNumber()),
        fix: "Use parameterized queries or the ORM's safe tagged-template API",
      });
    }
  }

  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    const constructorName = expression.getExpression().getText();
    if (
      constructorName !== "Function" &&
      constructorName !== "globalThis.Function"
    ) {
      continue;
    }
    issues.push({
      severity: "critical",
      rule: "unsafe-dynamic-code",
      message: "Runtime code execution uses the Function constructor",
      ...sourceLocation(
        sourceFile,
        projectPath,
        expression.getStartLineNumber(),
      ),
      fix: "Replace generated code with explicit parsing or a sandbox designed for untrusted code",
    });
  }

  for (const property of sourceFile.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    const name = property.getName().replace(/["']/g, "");
    const initializer = property.getInitializer();
    const disablesTls =
      (name === "rejectUnauthorized" &&
        initializer?.getKind() === SyntaxKind.FalseKeyword) ||
      (name === "NODE_TLS_REJECT_UNAUTHORIZED" &&
        Node.isStringLiteral(initializer) &&
        initializer.getLiteralText() === "0");
    if (!disablesTls) continue;

    issues.push({
      severity: "critical",
      rule: "tls-verification-disabled",
      message: "TLS certificate verification is disabled",
      ...sourceLocation(sourceFile, projectPath, property.getStartLineNumber()),
      fix: "Enable certificate verification and configure a trusted CA when a private PKI is required",
    });
  }

  for (const assignment of sourceFile.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    if (
      assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken ||
      assignment.getLeft().getText() !==
        "process.env.NODE_TLS_REJECT_UNAUTHORIZED"
    ) {
      continue;
    }
    const value = assignment.getRight();
    if (!Node.isStringLiteral(value) || value.getLiteralText() !== "0") {
      continue;
    }

    issues.push({
      severity: "critical",
      rule: "tls-verification-disabled",
      message: "TLS certificate verification is disabled globally",
      ...sourceLocation(
        sourceFile,
        projectPath,
        assignment.getStartLineNumber(),
      ),
      fix: "Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and configure a trusted CA instead",
    });
  }

  return issues;
}

export async function analyzeSecuritySinks(
  projectPath: string,
  ignore: string[],
): Promise<DiagnosticIssue[]> {
  const sourcePaths = await glob("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: projectPath,
    ignore: [...ignore, ...RUNTIME_IGNORES],
    absolute: true,
    nodir: true,
  });
  const project = new Project({
    compilerOptions: { allowJs: true, checkJs: false },
    skipAddingFilesFromTsConfig: true,
  });
  const issues: DiagnosticIssue[] = [];

  for (const sourcePath of sourcePaths) {
    try {
      issues.push(
        ...inspectSourceFile(
          project.addSourceFileAtPath(sourcePath),
          projectPath,
        ),
      );
    } catch {
      // A malformed or disappearing source file should not stop the scan.
    }
  }

  return issues;
}
