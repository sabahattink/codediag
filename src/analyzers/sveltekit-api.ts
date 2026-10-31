import type { SourceFile } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import type { ModuleIndex } from "./fastify-plugins.js";
import {
  delegates,
  Guards,
  hasOpaqueCalls,
  type Perimeter,
  serverPerimeter,
} from "./sveltekit-guards.js";
import {
  discoverRoutes,
  type KitConfig,
  type LoadFunction,
  type RequestHandler,
  readKitConfig,
  type Routes,
  svelteKitAliases,
} from "./sveltekit-routes.js";
import { BodyValidation } from "./sveltekit-validation.js";

/**
 * API Health for SvelteKit: +server request handlers and form actions are
 * the endpoints. Mutating ones need an auth check in the handle hook or in
 * the handler, body reads need a schema, and svelte.config.js must keep the
 * CSRF origin check. Auth in a layout or page load does not count: SvelteKit
 * runs form actions before load functions and +server files without them.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs,cjs,mts,cts}";
const HEALTH_PATH =
  /(?:^|\/)(?:health|healthz|live|ready|readiness|liveness)(?:\/|$)/i;
/** Route segments of sign-in flows, which are public by design. */
const AUTH_FLOW_SEGMENT =
  /^(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|registration|forgot-?password|reset-?password|password-?reset|verify-?email|magic-?link|auth|oauth|sso|otp|2fa|mfa|webauthn|passkeys?)$/i;
const AUTH_FLOW_ACTION =
  /^(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|forgot-?password|reset-?password|(?:request-?)?password-?reset|verify-?email|(?:send-?)?magic-?link|(?:verify|send|resend)-?otp)$/i;
/** Version 1 score shares, as in the other API analyzers. */
const AUTH_POINTS = 35;
const VALIDATION_POINTS = 30;
const CSRF_POINTS = 20;
const HEALTH_POINTS = 15;

interface Evaluated {
  handler: RequestHandler;
  /** A mutating handler that is not a sign-in flow, so it needs auth. */
  checksAuth: boolean;
  auth: boolean;
  /** A body method or form action that reads the request body. */
  checksBody: boolean;
  validated: boolean;
  authConfidence: "high" | "low";
  bodyConfidence: "high" | "low";
}

function runtimeSources(
  context: ScanContext,
): Array<{ file: string; sourceFile: SourceFile }> {
  const sources: Array<{ file: string; sourceFile: SourceFile }> = [];
  for (const file of context.matchFiles(SOURCE_PATTERN, {
    exclude: [
      "**/*.test.{ts,tsx,js,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,mjs,cjs}",
      "**/__tests__/**",
    ],
  })) {
    // A malformed source file should not prevent analysis of the rest.
    const sourceFile = context.getSourceFile(file);
    if (sourceFile) sources.push({ file, sourceFile });
  }
  return sources;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function label(handler: RequestHandler): string {
  if (handler.kind === "endpoint") return `${handler.method} ${handler.path}`;
  return handler.action === "default"
    ? `Default form action on ${handler.path}`
    : `Form action ?/${handler.action} on ${handler.path}`;
}

/** Sign-in, sign-up, and sign-out routes cannot require a signed-in caller. */
function isAuthFlow(handler: RequestHandler): boolean {
  return (
    handler.path
      .split("/")
      .some((segment) => AUTH_FLOW_SEGMENT.test(segment)) ||
    AUTH_FLOW_ACTION.test(handler.action ?? "")
  );
}

/**
 * The deepest page or layout load of a handler's route that checks auth.
 * It protects the page, but not the route's form actions, which run before
 * load functions, nor +server handlers, which no layout applies to.
 */
function loadGuard(
  guards: Guards,
  routes: Routes,
  config: KitConfig,
  handler: RequestHandler,
): string | null {
  const parts = handler.directory.split("/");
  const top = config.routes.split("/").length;
  const candidates: Array<LoadFunction | undefined> = [
    routes.pages.get(handler.directory),
  ];
  for (let length = parts.length; length >= top; length--) {
    candidates.push(routes.layouts.get(parts.slice(0, length).join("/")));
  }
  const guarded = candidates.find(
    (load) => load && guards.guards(load.fn, "handler", handler),
  );
  return guarded?.file ?? null;
}

function evaluateHandler(
  index: ModuleIndex,
  perimeter: Perimeter,
  guards: Guards,
  validation: BodyValidation,
  handler: RequestHandler,
): Evaluated {
  const { fn, wrappers } = handler;
  // A handler passing the request to another router, or one the scan
  // cannot read, is not judged.
  const judged = fn !== undefined && !delegates(fn);
  const body = judged
    ? validation.check(fn, wrappers)
    : { reads: false, validated: true, opaque: false };
  const mutating =
    handler.kind === "action" ||
    MUTATING_METHODS.has(handler.method) ||
    (handler.method === "fallback" && body.reads);
  const checksAuth = judged && mutating && !isAuthFlow(handler);
  const auth =
    !checksAuth ||
    perimeter.handles.some((handle) =>
      guards.guards(handle, "hook", handler),
    ) ||
    guards.handlerGuards(fn, wrappers, handler);
  const opaque = hasOpaqueCalls(index, [...(fn ? [fn] : []), ...wrappers]);
  return {
    handler,
    checksAuth,
    auth,
    checksBody:
      body.reads &&
      (handler.kind === "action" ||
        BODY_METHODS.has(handler.method) ||
        handler.method === "fallback"),
    validated: body.validated,
    authConfidence: perimeter.opaque || opaque ? "low" : "high",
    bodyConfidence: body.opaque ? "low" : "high",
  };
}

function authIssue(evaluated: Evaluated, hint: string | null): DiagnosticIssue {
  const { handler } = evaluated;
  const action = handler.kind === "action";
  return {
    ...fromRule("missing-sveltekit-auth"),
    message: `${label(handler)} has no recognizable auth check${
      hint
        ? `; the auth check in ${hint} load does not run for ${
            action ? "form actions" : "+server endpoints"
          }`
        : ""
    }`,
    file: handler.file,
    line: handler.line,
    fix: action
      ? "Check locals.user in the action and return fail(401) or redirect(), or reject anonymous requests to this route in the handle hook; load functions do not run before form actions"
      : "Reject anonymous requests in the handler, for example `if (!locals.user) error(401)`, or in the handle hook of src/hooks.server.ts for this path",
    confidence: evaluated.authConfidence,
  };
}

function csrfIssue(config: KitConfig): DiagnosticIssue[] {
  if (!config.csrf || !config.file) return [];
  const checkOrigin = config.csrf.setting === "checkOrigin";
  return [
    {
      ...fromRule("sveltekit-csrf-disabled"),
      message: `${
        checkOrigin
          ? "kit.csrf.checkOrigin is false"
          : "kit.csrf.trustedOrigins contains '*'"
      }, so cross-site form submissions from any origin are accepted`,
      file: config.file,
      line: config.csrf.node.getStartLineNumber(),
      fix: checkOrigin
        ? "Remove checkOrigin: false; list the origins that may post forms in kit.csrf.trustedOrigins"
        : "List the specific origins that may post forms in kit.csrf.trustedOrigins instead of '*'",
    },
  ];
}

function rate(subjects: Evaluated[], passes: (e: Evaluated) => boolean) {
  return subjects.length === 0
    ? 1
    : subjects.filter(passes).length / subjects.length;
}

export async function analyzeSvelteKitApi(
  context: ScanContext,
): Promise<AnalyzerResult | null> {
  const sources = runtimeSources(context);
  const index: ModuleIndex = {
    paths: new Map(sources.map(({ file, sourceFile }) => [sourceFile, file])),
    files: new Map(sources.map(({ file, sourceFile }) => [file, sourceFile])),
    aliases: svelteKitAliases(context),
  };
  const config = readKitConfig(context, index);
  const routes = discoverRoutes(context, index, config);

  if (routes.handlers.length === 0) {
    // An app of pages has no endpoints; +server files without handlers do.
    if (routes.files.length === 0 || routes.opaqueFiles > 0) return null;
    return {
      name: "API Health",
      score: 0,
      issues: [
        {
          ...fromRule("no-sveltekit-endpoints"),
          message:
            "SvelteKit +server files export no request handlers and no form actions were found",
        },
      ],
      summary: `${plural(routes.files.length, "+server file")}, 0 handlers`,
    };
  }

  const perimeter = serverPerimeter(context, index, config);
  const guards = new Guards(index);
  const validation = new BodyValidation(index);
  const fileOrder = new Map(routes.files.map((file, order) => [file, order]));
  const evaluated = [...routes.handlers]
    .sort(
      (left, right) =>
        (fileOrder.get(left.file) ?? 0) - (fileOrder.get(right.file) ?? 0) ||
        left.line - right.line,
    )
    .map((handler) =>
      evaluateHandler(index, perimeter, guards, validation, handler),
    );

  const authSubjects = evaluated.filter((entry) => entry.checksAuth);
  const bodySubjects = evaluated.filter((entry) => entry.checksBody);
  const healthy = routes.handlers.some(
    (handler) => handler.kind === "endpoint" && HEALTH_PATH.test(handler.path),
  );
  const csrf = csrfIssue(config);
  const issues: DiagnosticIssue[] = [
    ...authSubjects
      .filter((entry) => !entry.auth)
      .map((entry) =>
        authIssue(entry, loadGuard(guards, routes, config, entry.handler)),
      ),
    ...bodySubjects
      .filter((entry) => !entry.validated)
      .map((entry) => ({
        ...fromRule("missing-sveltekit-validation"),
        message: `${label(entry.handler)} reads the request body without schema validation`,
        file: entry.handler.file,
        line: entry.handler.line,
        fix: "Parse the body with a schema before using it, for example schema.safeParse(await request.json()) or superValidate(request, zod(schema))",
        confidence: entry.bodyConfidence,
      })),
    ...csrf,
    ...(healthy
      ? []
      : [
          {
            ...fromRule("missing-health-endpoint"),
            message: "No health, readiness, or liveness endpoint detected",
            fix: "Add a lightweight GET endpoint such as src/routes/health/+server.ts for runtime monitoring",
          },
        ]),
  ];

  const score = Math.round(
    rate(authSubjects, (entry) => entry.auth) * AUTH_POINTS +
      rate(bodySubjects, (entry) => entry.validated) * VALIDATION_POINTS +
      (csrf.length === 0 ? CSRF_POINTS : 0) +
      (healthy ? HEALTH_POINTS : 0),
  );
  const endpoints = routes.handlers.filter(
    (handler) => handler.kind === "endpoint",
  ).length;
  return {
    name: "API Health",
    score,
    issues,
    summary: `${plural(endpoints, "SvelteKit endpoint")} and ${plural(
      routes.handlers.length - endpoints,
      "form action",
    )} in ${plural(routes.files.length, "route file")}`,
  };
}
