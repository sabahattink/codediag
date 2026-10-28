import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";
import { inspectAuthConfiguration } from "./security-auth.js";
import { inspectInjection } from "./security-injection.js";
import {
  calleeName,
  dynamicStringShape,
  enclosingScope,
  isRequestValue,
  isStaticString,
  isTainted,
  type ModuleBindings,
  moduleBindings,
  moduleCall,
  objectProperty,
  RUNTIME_IGNORES,
  RESPONSE_OBJECT,
  requestDecorator,
  SOURCE_PATTERN,
  stringParts,
  unwrap,
} from "./taint.js";

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const COMMAND_FUNCTIONS = new Set(["exec", "execSync"]);
/** Functions that run an executable directly unless a `shell` option is set. */
const SPAWN_FUNCTIONS = new Set([
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
const FS_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "fs-extra",
]);
/** File system functions whose first argument is a path to read or change. */
const FILE_FUNCTIONS = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createReadStream",
  "createWriteStream",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);
const HTTP_CLIENT_FUNCTIONS = new Set([
  "axios",
  "fetch",
  "got",
  "ky",
  "needle",
]);
const HTTP_CLIENT_RECEIVER =
  /(?:^|\.)(?:axios|got|ky|http|https|httpService|needle|superagent|undici)$/;
const HTTP_CLIENT_METHODS = new Set([
  "delete",
  "fetch",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "request",
  "stream",
]);
const SQL_METHODS = new Set([
  "$executeRawUnsafe",
  "$queryRawUnsafe",
  "execute",
  "query",
  "raw",
]);
const SQL_RECEIVER =
  /(?:^|\.)(?:client|connection|database|db|entityManager|knex|pool|prisma|queryRunner|sql)$/i;
const SQL_KEYWORDS =
  /\b(?:select|insert\s+into|update|delete\s+from|from|where|values|join)\b/i;

function sourceLocation(file: string, line: number) {
  return { file, line };
}

function isDynamicSqlCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return false;
  if (!SQL_METHODS.has(expression.getName())) return false;

  const query = call.getArguments()[0];
  if (!query || isStaticString(query)) return false;
  if (
    expression.getName().endsWith("Unsafe") ||
    SQL_RECEIVER.test(expression.getExpression().getText())
  ) {
    return true;
  }

  // Any receiver: a query string built from request data is SQL injection.
  const shape = dynamicStringShape(query);
  return Boolean(
    shape && SQL_KEYWORDS.test(shape.getText()) && isTainted(query),
  );
}

/**
 * Text that pins a URL's origin before its first request-controlled part:
 * `https://host/`, `${base}/`, or a same-site path such as `/account`. A
 * protocol-relative `//` start does not count.
 */
const FIXED_ORIGIN =
  /^(?:[a-z][a-z\d+.-]*:\/\/[^/?#\\]+[/?#]|[^:/?#\\]+[/?#]|\/[^/\\])/i;

/**
 * True when request data decides where a URL points: it is used before the
 * literal text fixes the scheme and host. Other expressions count as fixed.
 */
function requestControlsTarget(node: Node): boolean {
  let prefix = "";
  for (const part of stringParts(node)) {
    if (typeof part === "string") prefix += part;
    else if (isRequestValue(part)) return !FIXED_ORIGIN.test(prefix);
    else prefix += "X";
  }
  return false;
}

/** For `res.status(200).send(x)`: the final method and the calls before it. */
function responseCall(
  call: CallExpression,
): { method: string; chain: CallExpression[] } | null {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return null;
  const chain: CallExpression[] = [];
  let receiver: Node = expression.getExpression();
  while (
    Node.isCallExpression(receiver) &&
    Node.isPropertyAccessExpression(receiver.getExpression())
  ) {
    chain.push(receiver);
    receiver = (
      receiver.getExpression() as PropertyAccessExpression
    ).getExpression();
  }
  if (
    !Node.isIdentifier(receiver) ||
    !RESPONSE_OBJECT.test(receiver.getText())
  ) {
    return null;
  }
  return { method: expression.getName(), chain };
}

/** True when the enclosing function checks a variable with `startsWith()`. */
function isPrefixChecked(argument: Node): boolean {
  const scopeText = enclosingScope(argument).getText();
  const value = unwrap(argument);
  const identifiers = Node.isIdentifier(value)
    ? [value]
    : value.getDescendantsOfKind(SyntaxKind.Identifier);
  return identifiers.some((identifier) =>
    new RegExp(
      `\\b${identifier.getText().replace(/\$/g, "\\$")}\\s*\\.\\s*startsWith\\s*\\(`,
    ).test(scopeText),
  );
}

/** The file path a call reads or changes when request data chooses it. */
function traversalPath(
  call: CallExpression,
  files: ModuleBindings,
): Node | null {
  if (moduleCall(call, files, FS_MODULES, FILE_FUNCTIONS)) {
    const paths = call.getArguments().slice(0, 1);
    if (/^(?:copyFile|rename)/.test(calleeName(call))) {
      paths.push(...call.getArguments().slice(1, 2));
    }
    return (
      paths.find((path) => isRequestValue(path) && !isPrefixChecked(path)) ??
      null
    );
  }

  const response = responseCall(call);
  if (!response || !["download", "sendFile"].includes(response.method)) {
    return null;
  }
  const [path, ...options] = call.getArguments();
  // Express rejects `..` segments when a root directory is given.
  if (options.some((option) => objectProperty(option, ["root"]))) return null;
  return path && isRequestValue(path) && !isPrefixChecked(path) ? path : null;
}

/** The URL an outgoing HTTP request uses, when request data picks its host. */
function forgedRequestUrl(call: CallExpression): Node | null {
  const expression = call.getExpression();
  const isClient = Node.isIdentifier(expression)
    ? HTTP_CLIENT_FUNCTIONS.has(expression.getText())
    : Node.isPropertyAccessExpression(expression) &&
      HTTP_CLIENT_METHODS.has(expression.getName()) &&
      HTTP_CLIENT_RECEIVER.test(expression.getExpression().getText());
  if (!isClient) return null;

  const [first] = call.getArguments();
  const url =
    objectProperty(first, ["url", "baseURL", "host", "hostname"]) ?? first;
  return url && requestControlsTarget(url) ? url : null;
}

const REDIRECT_RECEIVER = /^(?:NextResponse|Response)$/;

/** The redirect target, when request data can send users to another site. */
function openRedirectTarget(call: CallExpression): Node | null {
  const expression = call.getExpression();
  let target: Node | undefined;
  if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getName() === "redirect" &&
    REDIRECT_RECEIVER.test(expression.getExpression().getText())
  ) {
    target = call.getArguments()[0];
  } else if (responseCall(call)?.method === "redirect") {
    // Express also accepts redirect(status, url).
    target = call.getArguments().at(-1);
  }
  return target && requestControlsTarget(target) ? target : null;
}

const NON_HTML_TYPE =
  /json|text\/(?:plain|csv|event-stream)|octet-stream|application\/xml/i;
/** A content type set before the body: `res.type("json")`, `setHeader(...)`. */
const DECLARED_NON_HTML_TYPE =
  /(?:content-type["'`]?\s*[,:]\s*|\.(?:type|contentType)\(\s*)["'`](?:json|text\/(?:plain|csv|event-stream)|application\/(?:json|xml|octet-stream))/i;
/** Parsed request objects, which Express sends as JSON rather than HTML. */
const REQUEST_OBJECT_VALUE =
  /(?:^|\.)(?:body|cookies|headers|params|query)$|\.(?:formData|json)\(\)$/;

/** True when request data is written into a response body served as HTML. */
function reflectsRequestData(body: Node | undefined): boolean {
  if (!body) return false;
  const value = unwrap(body);
  // `const { name } = req.query` binds one field, not the parsed object.
  if (
    Node.isIdentifier(value) &&
    value
      .getSymbol()
      ?.getDeclarations()
      .some((declaration) => Node.isBindingElement(declaration))
  ) {
    return isRequestValue(value);
  }
  const parts = stringParts(value);
  if (parts.length === 1) {
    const [part] = parts;
    if (typeof part === "string") return false;
    const node = unwrap(part);
    // `@Body() dto` without a field name injects the parsed object.
    const decorator = Node.isIdentifier(node)
      ? requestDecorator(node)
      : undefined;
    if (decorator && decorator.getArguments().length === 0) return false;
    return !REQUEST_OBJECT_VALUE.test(node.getText()) && isRequestValue(node);
  }
  return parts.some((part) => typeof part !== "string" && isRequestValue(part));
}

function reflectedResponseBody(call: CallExpression): Node | null {
  const response = responseCall(call);
  // Fastify's reply.send() serves strings as text/plain.
  if (
    !response ||
    !["end", "send", "write"].includes(response.method) ||
    /^reply\b/.test(call.getExpression().getText())
  ) {
    return null;
  }
  if (
    response.chain.some((link) => NON_HTML_TYPE.test(link.getText())) ||
    DECLARED_NON_HTML_TYPE.test(enclosingScope(call).getText())
  ) {
    return null;
  }
  const [body] = call.getArguments();
  return body && reflectsRequestData(body) ? body : null;
}

/** True when a spawn options object turns on a shell: `{ shell: true }`. */
function enablesShell(options: Node): boolean {
  const shell = objectProperty(options, ["shell"]);
  return Boolean(
    shell &&
      (shell.getKind() === SyntaxKind.TrueKeyword ||
        (Node.isStringLiteral(shell) && shell.getLiteralText() !== "")),
  );
}

/**
 * The non-literal command and argument expressions of `spawn(cmd, args,
 * { shell: true })`, which a shell joins into one command line.
 */
function shellCommandParts(call: CallExpression): Node[] {
  const [command, second] = call.getArguments();
  if (!command || !call.getArguments().some(enablesShell)) return [];
  const parts: Node[] = [command];
  if (second && Node.isArrayLiteralExpression(second)) {
    parts.push(...second.getElements());
  } else if (second && !Node.isObjectLiteralExpression(second)) {
    parts.push(second);
  }
  return parts.filter((part) => !isStaticString(part));
}

function severityForDynamicInput(
  node: Node | undefined,
): DiagnosticIssue["severity"] {
  return node && isTainted(node) ? "critical" : "warning";
}

function inspectSourceFile(
  sourceFile: SourceFile,
  file: string,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const commands = moduleBindings(
    sourceFile,
    CHILD_PROCESS_MODULES,
    COMMAND_FUNCTIONS,
  );
  const spawns = moduleBindings(
    sourceFile,
    CHILD_PROCESS_MODULES,
    SPAWN_FUNCTIONS,
  );
  const files = moduleBindings(sourceFile, FS_MODULES, FILE_FUNCTIONS);

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
        ...fromRule("unsafe-dynamic-code"),
        message: "Runtime code execution uses eval()",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Replace eval() with explicit parsing, dispatch, or a sandbox designed for untrusted code",
      });
      continue;
    }

    if (moduleCall(call, commands, CHILD_PROCESS_MODULES, COMMAND_FUNCTIONS)) {
      const command = call.getArguments()[0];
      if (command && !isStaticString(command)) {
        issues.push({
          ...fromRule("dynamic-command-execution"),
          severity: severityForDynamicInput(command),
          message: "Shell execution receives a non-literal command",
          ...sourceLocation(file, call.getStartLineNumber()),
          fix: "Avoid a shell; use execFile or spawn with a fixed executable and validated argument array",
        });
      }
    }

    if (moduleCall(call, spawns, CHILD_PROCESS_MODULES, SPAWN_FUNCTIONS)) {
      const parts = shellCommandParts(call);
      if (parts.length > 0) {
        issues.push({
          ...fromRule("dynamic-command-execution"),
          severity: parts.some((part) => isTainted(part))
            ? "critical"
            : "warning",
          message: "A shell runs a command built from non-literal arguments",
          ...sourceLocation(file, call.getStartLineNumber()),
          fix: "Remove the shell option and pass a fixed executable with a validated argument array",
        });
      }
    }

    if (isDynamicSqlCall(call)) {
      const query = call.getArguments()[0];
      issues.push({
        ...fromRule("dynamic-sql-query"),
        severity: severityForDynamicInput(query),
        message: "SQL execution uses a dynamically constructed query",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Use parameterized queries or the ORM's safe tagged-template API",
      });
    }

    if (traversalPath(call, files)) {
      issues.push({
        ...fromRule("path-traversal"),
        message: "A file path is built from request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Resolve the path against a fixed base directory and reject it unless it stays inside, or use path.basename() for plain file names",
      });
    }

    if (forgedRequestUrl(call)) {
      issues.push({
        ...fromRule("server-side-request-forgery"),
        message: "An outgoing HTTP request uses a URL chosen by request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Fix the scheme and host in code, or check the parsed URL's host against an allowlist before sending the request",
      });
    }

    if (openRedirectTarget(call)) {
      issues.push({
        ...fromRule("open-redirect"),
        message: "A redirect target comes from request data",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Redirect only to same-site paths (one leading slash) or to hosts on an allowlist",
      });
    }

    if (reflectedResponseBody(call)) {
      issues.push({
        ...fromRule("reflected-xss"),
        message:
          "Request data is written into an HTML response without escaping",
        ...sourceLocation(file, call.getStartLineNumber()),
        fix: "Render through an escaping template engine, escape the value for HTML, or send JSON with res.json()",
      });
    }
  }

  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    const constructorName = expression.getExpression().getText();
    const [body, init] = expression.getArguments();
    if (
      REDIRECT_RECEIVER.test(constructorName) &&
      init &&
      /text\/html/i.test(init.getText()) &&
      reflectsRequestData(body)
    ) {
      issues.push({
        ...fromRule("reflected-xss"),
        message:
          "Request data is written into an HTML response without escaping",
        ...sourceLocation(file, expression.getStartLineNumber()),
        fix: "Render through an escaping template engine, escape the value for HTML, or return JSON",
      });
      continue;
    }
    if (
      constructorName !== "Function" &&
      constructorName !== "globalThis.Function"
    ) {
      continue;
    }
    issues.push({
      ...fromRule("unsafe-dynamic-code"),
      message: "Runtime code execution uses the Function constructor",
      ...sourceLocation(file, expression.getStartLineNumber()),
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
      ...fromRule("tls-verification-disabled"),
      message: "TLS certificate verification is disabled",
      ...sourceLocation(file, property.getStartLineNumber()),
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
      ...fromRule("tls-verification-disabled"),
      message: "TLS certificate verification is disabled globally",
      ...sourceLocation(file, assignment.getStartLineNumber()),
      fix: "Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and configure a trusted CA instead",
    });
  }

  return issues;
}

export async function analyzeSecuritySinks(
  context: ScanContext,
): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: RUNTIME_IGNORES,
  })) {
    const sourceFile = context.getSourceFile(file);
    if (!sourceFile) continue;
    try {
      issues.push(
        ...inspectSourceFile(sourceFile, file),
        ...inspectInjection(sourceFile, file),
        ...inspectAuthConfiguration(sourceFile, file),
      );
    } catch {
      // A malformed source file should not stop the scan.
    }
  }

  return issues;
}
