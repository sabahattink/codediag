import { type CallExpression, Node, type SourceFile } from "ts-morph";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule, getRule } from "../rules/registry.js";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";
import { type ModuleIndex, pathAliases } from "./fastify-plugins.js";
import { svelteKitAliases } from "./sveltekit-routes.js";
import { perimeterAuth } from "./trpc-perimeter.js";
import {
  type Procedure,
  type StackExposure,
  TrpcResolver,
} from "./trpc-procedures.js";

/**
 * tRPC procedure checks for API Health. tRPC usually runs inside another
 * server (a Next.js route handler, Express or Fastify middleware), so these
 * checks join that framework's API analyzer; a project whose only server is
 * tRPC (the standalone adapter, or a package that only defines routers) gets
 * them on their own.
 */

export type ApiAnalyzer = (
  context: ScanContext,
) => Promise<AnalyzerResult | null>;

type Sources = ReadonlyArray<{ file: string; sourceFile: SourceFile }>;

const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs,cjs}";
const HEALTH_SEGMENT =
  /^(?:health|healthz|healthcheck|live|liveness|ready|readiness)$/i;
/** Version 1 score shares, as in the other API analyzers. */
const AUTH_POINTS = 35;
const VALIDATION_POINTS = 30;
const ERROR_POINTS = 20;
const HEALTH_POINTS = 15;

interface TrpcAnalysis {
  issues: DiagnosticIssue[];
  procedures: number;
  adapters: number;
  hasHealthEndpoint: boolean;
  /** The version 1 score without the health endpoint's share. */
  points: number;
  summary: string;
}

function dependsOnTrpc(context: ScanContext): boolean {
  return (
    "@trpc/server" in (context.packageJson?.dependencies ?? {}) ||
    "@trpc/server" in (context.packageJson?.devDependencies ?? {})
  );
}

function runtimeSources(context: ScanContext): Sources {
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

function moduleIndex(context: ScanContext, sources: Sources): ModuleIndex {
  const typescript = context.typescriptConfig();
  return {
    paths: new Map(sources.map(({ file, sourceFile }) => [sourceFile, file])),
    files: new Map(sources.map(({ file, sourceFile }) => [file, sourceFile])),
    // T3 apps import their builders through `~/server/api/trpc`, SvelteKit
    // apps through `$lib/trpc`.
    aliases:
      context.stack.framework === "sveltekit"
        ? svelteKitAliases(context)
        : typescript.status === "ok"
          ? pathAliases(typescript.options, context.projectPath)
          : [],
  };
}

function isProtected(procedure: Procedure): boolean {
  return procedure.builder.middleware.some((step) => step.auth);
}

function authIssues(mutations: Procedure[]): DiagnosticIssue[] {
  return mutations
    .filter((procedure) => !isProtected(procedure))
    .map((procedure) => ({
      ...fromRule("missing-trpc-auth-middleware"),
      message: `Mutation ${procedure.path} has no recognizable auth middleware`,
      file: procedure.file,
      line: procedure.line,
      fix: "Build the mutation on a procedure whose .use() middleware rejects anonymous callers, for example by throwing new TRPCError({ code: 'UNAUTHORIZED' }) when ctx.session is missing",
      // A builder or middleware known only by name makes this a guess.
      confidence:
        procedure.builder.confidence === "low" ||
        procedure.builder.middleware.some((step) => step.opaque)
          ? "low"
          : "high",
    }));
}

/**
 * Parsers that accept every value. A parser shared through a builder is
 * reported once, where it is declared, naming the first procedure using it.
 */
function inputIssues(
  resolver: TrpcResolver,
  index: ModuleIndex,
  procedures: Procedure[],
): { issues: DiagnosticIssue[]; permissive: Set<CallExpression> } {
  const users = new Map<CallExpression, Procedure>();
  for (const procedure of procedures) {
    for (const input of procedure.builder.inputs) {
      if (!users.has(input)) users.set(input, procedure);
    }
  }
  const issues: DiagnosticIssue[] = [];
  const permissive = new Set<CallExpression>();
  for (const [call, procedure] of users) {
    const parser = resolver.permissiveInput(call);
    if (!parser) continue;
    permissive.add(call);
    const callee = call.getExpression();
    issues.push({
      ...fromRule("unvalidated-trpc-input"),
      message: `Input of ${procedure.kind} ${procedure.path} is not validated: ${
        parser.schema === null
          ? "the parser returns its argument without checking it"
          : `${parser.schema} accepts any value`
      }`,
      file: index.paths.get(call.getSourceFile()) ?? procedure.file,
      line: Node.isPropertyAccessExpression(callee)
        ? callee.getNameNode().getStartLineNumber()
        : call.getStartLineNumber(),
      fix: "Pass a schema that describes the input, such as z.object({ ... }), or a parser function that throws on invalid values",
      confidence: parser.confidence,
    });
  }
  return { issues, permissive };
}

function stackIssue(file: string, exposure: StackExposure): DiagnosticIssue {
  return {
    ...fromRule("trpc-stack-trace-exposed"),
    file,
    line: exposure.node.getStartLineNumber(),
    ...(exposure.via === "isDev"
      ? {
          message:
            "initTRPC.create() sets isDev: true, so error responses include stack traces in production",
          fix: "Remove isDev: true; tRPC derives it from NODE_ENV",
        }
      : {
          message: `The tRPC errorFormatter returns ${exposure.node.getText()} in every environment`,
          fix: "Return the stack only when NODE_ENV is development, or keep shape.data.stack, which tRPC fills only outside production",
        }),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function analyzeProcedures(context: ScanContext): TrpcAnalysis {
  const sources = runtimeSources(context);
  const index = moduleIndex(context, sources);
  const resolver = new TrpcResolver(index);
  const project = resolver.collect(sources);
  const { procedures } = project;

  const mutations = procedures.filter(({ kind }) => kind === "mutation");
  // Auth in front of every procedure makes their own middleware optional.
  const perimeter = mutations.length > 0 ? perimeterAuth(index, sources) : null;
  const auth = perimeter ? [] : authIssues(mutations);
  const inputs = inputIssues(resolver, index, procedures);
  const stacks = project.instances.flatMap((create) => {
    const file = index.paths.get(create.getSourceFile()) ?? "";
    return resolver
      .stackExposures(create)
      .map((exposure) => stackIssue(file, exposure));
  });

  const withInput = procedures.filter(({ builder }) => builder.inputs.length);
  const validated = withInput.filter(({ builder }) =>
    builder.inputs.every((input) => !inputs.permissive.has(input)),
  );
  const authRate =
    mutations.length === 0
      ? 1
      : (mutations.length - auth.length) / mutations.length;
  const validationRate =
    withInput.length === 0 ? 1 : validated.length / withInput.length;
  return {
    issues: [...auth, ...inputs.issues, ...stacks],
    procedures: procedures.length,
    adapters: project.adapters,
    hasHealthEndpoint: procedures.some(({ path }) =>
      path.split(".").some((segment) => HEALTH_SEGMENT.test(segment)),
    ),
    points:
      authRate * AUTH_POINTS +
      validationRate * VALIDATION_POINTS +
      (stacks.length === 0 ? ERROR_POINTS : 0),
    summary: `${plural(procedures.length, "tRPC procedure")}${
      project.routers > 0 ? ` in ${plural(project.routers, "router")}` : ""
    }${perimeter ? `; ${perimeter}` : ""}`,
  };
}

/** A finding that means the framework analyzer found no endpoints at all. */
function foundNothing(issue: DiagnosticIssue): boolean {
  return getRule(issue.rule)?.failsAnalyzer === true;
}

/**
 * Adds the tRPC procedures to a framework's API Health result. Procedures
 * are endpoints, so a framework that found none of its own (a Next.js app
 * whose only API route is the tRPC handler) is replaced by the tRPC result,
 * and a health procedure counts as a health endpoint.
 */
function combine(
  framework: AnalyzerResult | null,
  trpc: TrpcAnalysis,
): AnalyzerResult | null {
  const evaluated = framework !== null && !framework.issues.some(foundNothing);
  if (trpc.procedures === 0) {
    // A tRPC handler serving a router this scan cannot see, such as one
    // defined in another workspace package, leaves nothing to evaluate.
    return !evaluated && trpc.adapters > 0 ? null : framework;
  }
  const frameworkHealthy =
    evaluated &&
    !framework.issues.some((issue) => issue.rule === "missing-health-endpoint");
  const healthy = trpc.hasHealthEndpoint || frameworkHealthy;
  const issues = [
    ...(evaluated
      ? framework.issues.filter(
          (issue) => !healthy || issue.rule !== "missing-health-endpoint",
        )
      : []),
    ...trpc.issues,
    ...(healthy || evaluated
      ? []
      : [
          {
            ...fromRule("missing-health-endpoint"),
            message:
              "No health, readiness, or liveness endpoint or procedure detected",
            fix: "Add a lightweight health procedure or route for runtime monitoring",
          },
        ]),
  ];
  const score = Math.round(trpc.points + (healthy ? HEALTH_POINTS : 0));
  return {
    name: "API Health",
    score: evaluated ? Math.round((framework.score + score) / 2) : score,
    issues,
    summary: evaluated ? `${framework.summary}; ${trpc.summary}` : trpc.summary,
  };
}

/** Runs a framework's API analyzer and adds tRPC procedure checks to it. */
export function withTrpcProcedures(analyze: ApiAnalyzer): ApiAnalyzer {
  return async (context) => {
    const result = await analyze(context);
    return dependsOnTrpc(context)
      ? combine(result, analyzeProcedures(context))
      : result;
  };
}

/** API Health for projects whose only server is tRPC. */
export const analyzeTrpcApi: ApiAnalyzer = withTrpcProcedures(() =>
  Promise.resolve(null),
);
