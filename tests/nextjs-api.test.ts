import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeNextjsApi } from "../src/analyzers/nextjs-api.js";
import { createScanContext } from "../src/core/scan-context.js";
import { scan } from "../src/scanner.js";

function createNextProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-nextjs-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "nextjs-fixture",
      dependencies: { next: "^15.0.0" },
    }),
  );
  return directory;
}

function writeRoute(directory: string, path: string, source: string): void {
  const target = join(directory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

test("Next.js analyzer handles App Router methods and dynamic paths", async () => {
  const directory = createNextProject();
  writeRoute(
    directory,
    join("src", "app", "api", "users", "[id]", "route.ts"),
    `
      export async function PUT(request: Request) {
        const session = await auth();
        const result = userSchema.safeParse(await request.json());
        return Response.json({ session, result });
      }
    `,
  );
  writeRoute(
    directory,
    join("src", "app", "api", "health", "route.ts"),
    'export const GET = () => Response.json({ status: "ok" });',
  );

  try {
    const result = await analyzeNextjsApi(createScanContext(directory));
    assert.ok(result);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
    assert.match(result.summary, /^2 Next\.js handlers/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Next.js analyzer reports missing mutating route safeguards", async () => {
  const directory = createNextProject();
  writeRoute(
    directory,
    join("app", "api", "items", "route.js"),
    `
      export async function POST(request) {
        const body = await request.json();
        return Response.json(body);
      }
    `,
  );

  try {
    const result = await analyzeNextjsApi(createScanContext(directory));
    assert.ok(result);
    assert.equal(result.score, 20);
    assert.deepEqual(
      result.issues.map((issue) => issue.rule),
      [
        "missing-auth-check",
        "missing-request-validation",
        "missing-health-endpoint",
      ],
    );
    assert.equal(result.issues[0]?.file, "app/api/items/route.js");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Next.js analyzer recognizes Pages Router method branches", async () => {
  const directory = createNextProject();
  writeRoute(
    directory,
    join("pages", "api", "health.ts"),
    `
      export default function handler(request, response) {
        if (request.method === "GET") response.status(200).json({ status: "ok" });
        else response.status(405).end();
      }
    `,
  );

  try {
    const result = await analyzeNextjsApi(createScanContext(directory));
    assert.ok(result);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frontend-only Next.js projects do not receive an API score", async () => {
  const directory = createNextProject();
  mkdirSync(join(directory, "app"));
  writeFileSync(
    join(directory, "app", "page.tsx"),
    "export default function Page() { return null; }",
  );

  try {
    assert.equal(await analyzeNextjsApi(createScanContext(directory)), null);
    const result = await scan(directory);
    assert.equal(result.stack.framework, "nextjs");
    assert.equal(
      result.analyzers.some((analyzer) => analyzer.name === "API Health"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("middleware protects the API routes it turns anonymous requests away from", async () => {
  const routes: Record<string, string> = {
    "src/app/api/posts/route.ts": [
      'import { z } from "zod";',
      "const schema = z.object({ title: z.string() });",
      "export async function POST(request: Request) {",
      "  const result = schema.safeParse(await request.json());",
      "  return Response.json(result);",
      "}",
    ].join("\n"),
    "src/app/api/admin/users/[id]/route.ts": [
      "export async function DELETE() {",
      "  return new Response(null, { status: 204 });",
      "}",
    ].join("\n"),
    "src/app/api/health/route.ts":
      'export const GET = () => Response.json({ status: "ok" });',
  };
  const unprotected = async (
    middleware: string,
    files: Record<string, string> = {},
  ) => {
    const directory = createNextProject();
    try {
      for (const [path, source] of Object.entries({
        ...routes,
        ...files,
        "src/middleware.ts": middleware,
      })) {
        writeRoute(directory, path, source);
      }
      const result = await analyzeNextjsApi(createScanContext(directory));
      return (result?.issues ?? [])
        .filter((issue) => issue.rule === "missing-auth-check")
        .map((issue) => issue.message);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const POSTS = "POST /api/posts has no recognizable auth check";
  const ADMIN = "DELETE /api/admin/users/:id has no recognizable auth check";

  assert.deepEqual(
    await unprotected(
      [
        'import { NextResponse, type NextRequest } from "next/server";',
        "export function middleware(request: NextRequest) {",
        '  const session = request.cookies.get("session")?.value;',
        '  if (!session && request.nextUrl.pathname.startsWith("/api/admin")) {',
        '    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
        "  }",
        "  return NextResponse.next();",
        "}",
      ].join("\n"),
    ),
    [POSTS],
  );
  assert.deepEqual(
    await unprotected(
      [
        'import { NextResponse, type NextRequest } from "next/server";',
        "export function middleware(request: NextRequest) {",
        '  if (!request.cookies.get("session")) {',
        '    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
        "  }",
        "  return NextResponse.next();",
        "}",
        'export const config = { matcher: ["/api/:path*"] };',
      ].join("\n"),
    ),
    [],
  );
  // clerkMiddleware() alone keeps every route public.
  assert.deepEqual(
    await unprotected(
      [
        'import { clerkMiddleware } from "@clerk/nextjs/server";',
        "export default clerkMiddleware();",
      ].join("\n"),
    ),
    [ADMIN, POSTS],
  );
  // Supabase's updateSession() redirects anonymous requests outside /login.
  assert.deepEqual(
    await unprotected(
      [
        'import { type NextRequest } from "next/server";',
        'import { updateSession } from "./lib/supabase/middleware";',
        "export async function middleware(request: NextRequest) {",
        "  return await updateSession(request);",
        "}",
      ].join("\n"),
      {
        "src/lib/supabase/middleware.ts": [
          'import { createServerClient } from "@supabase/ssr";',
          'import { NextResponse, type NextRequest } from "next/server";',
          "export async function updateSession(request: NextRequest) {",
          "  const supabaseResponse = NextResponse.next({ request });",
          "  const supabase = createServerClient(url, key, { cookies });",
          "  const {",
          "    data: { user },",
          "  } = await supabase.auth.getUser();",
          "  if (",
          "    !user &&",
          '    !request.nextUrl.pathname.startsWith("/login") &&',
          '    !request.nextUrl.pathname.startsWith("/auth")',
          "  ) {",
          "    const url = request.nextUrl.clone();",
          '    url.pathname = "/login";',
          "    return NextResponse.redirect(url);",
          "  }",
          "  return supabaseResponse;",
          "}",
        ].join("\n"),
      },
    ),
    [],
  );
});
