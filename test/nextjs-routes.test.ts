import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { discoverNextRoutes, matcherToRegExp } from "../src/discovery/nextjs-routes.js";
import type { RouteInfo } from "../src/analyzers/api-common.js";

function discover(files: Record<string, string>): RouteInfo[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  for (const [path, text] of Object.entries(files)) project.createSourceFile(path, text);
  return discoverNextRoutes(project, "/");
}

function route(routes: readonly RouteInfo[], method: string, path: string): RouteInfo {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`${method} ${path} not found in ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  return found;
}

const usersRoute = [
  'import { NextResponse } from "next/server";',
  "export async function GET() {",
  "  return NextResponse.json(await db.users.findMany());",
  "}",
  "export async function POST(request: Request) {",
  "  const body = await request.json();",
  "  return NextResponse.json(await db.users.create({ data: body }));",
  "}",
].join("\n");

describe("discoverNextRoutes — App Router", () => {
  it("discovers exported HTTP method functions in app/**/route.ts", () => {
    const routes = discover({ "/app/api/users/route.ts": usersRoute });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/users", "POST /api/users"]);
    expect(route(routes, "POST", "/api/users")).toMatchObject({
      file: "app/api/users/route.ts",
      line: 5,
      hasAuth: false,
      readsBody: true,
      hasValidation: false,
    });
    expect(route(routes, "GET", "/api/users").readsBody).toBe(false);
  });

  it("maps route groups, slots, dynamic segments and src/app; skips private folders", () => {
    const handler = "export function GET() { return new Response(); }";
    const routes = discover({
      "/src/app/(admin)/api/posts/[id]/route.ts": handler,
      "/app/@modal/api/photos/[...slug]/route.ts": handler,
      "/app/route.ts": handler,
      "/app/_lib/route.ts": handler,
      "/app/api/users/helpers.ts": handler,
      "/app/page.tsx": "export default function Page() { return null; }",
    });
    expect(routes.map((r) => r.path).sort()).toEqual(["/", "/api/photos/[...slug]", "/api/posts/[id]"]);
  });

  it("supports const exports, export aliases and auth wrappers", () => {
    const routes = discover({
      "/app/api/items/route.ts": [
        "export const PATCH = async (req: Request) => {",
        "  const input = itemSchema.parse(await req.json());",
        "  return Response.json(input);",
        "};",
        "const handler = async (req: Request) => Response.json({});",
        "export { handler as PUT, handler as DELETE };",
        "export const POST = withAuth(async (req: Request) => Response.json(await req.json()));",
      ].join("\n"),
    });
    expect(routes.map((r) => r.method).sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
    expect(route(routes, "PATCH", "/api/items")).toMatchObject({ readsBody: true, hasValidation: true, hasAuth: false });
    expect(route(routes, "PUT", "/api/items")).toMatchObject({ readsBody: false });
    expect(route(routes, "POST", "/api/items")).toMatchObject({ hasAuth: true, readsBody: true });
  });

  it("detects auth checks inside the handler", () => {
    const routes = discover({
      "/app/api/a/route.ts": "export async function POST() {\n  const session = await auth();\n  if (!session) return new Response(null, { status: 401 });\n  return Response.json({});\n}",
      "/app/api/b/route.ts": "export async function DELETE() {\n  const session = await getServerSession(authOptions);\n  return Response.json(session);\n}",
      "/app/api/c/route.ts": 'export async function PUT(req: Request) {\n  const token = req.headers.get("authorization");\n  return Response.json(token);\n}',
    });
    expect(route(routes, "POST", "/api/a").hasAuth).toBe(true);
    expect(route(routes, "DELETE", "/api/b").hasAuth).toBe(true);
    expect(route(routes, "PUT", "/api/c").hasAuth).toBe(true);
  });

  it("keeps routes whose handlers cannot be resolved (readsBody = null)", () => {
    const routes = discover({
      "/app/api/auth/[...nextauth]/route.ts": 'import { handlers } from "@/auth";\nexport const { GET, POST } = handlers;',
      "/app/api/legacy/route.ts": 'export { GET, POST } from "@/lib/legacy";',
    });
    expect(route(routes, "POST", "/api/auth/[...nextauth]").readsBody).toBeNull();
    expect(route(routes, "POST", "/api/legacy").readsBody).toBeNull();
  });
});

describe("discoverNextRoutes — Pages Router", () => {
  it("derives methods from req.method checks and paths from the file name", () => {
    const routes = discover({
      "/pages/api/users/[id].ts": [
        "export default async function handler(req, res) {",
        '  if (req.method === "DELETE") return res.status(204).end();',
        "  switch (req.method) {",
        '    case "PUT":',
        "      return res.json(await db.update(req.body));",
        "  }",
        "}",
      ].join("\n"),
      "/src/pages/api/index.ts": "export default function handler(req, res) { res.json({ ok: true }); }",
      "/pages/about.tsx": "export default function About() { return null; }",
    });
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["ANY /api", "DELETE /api/users/[id]", "PUT /api/users/[id]"]);
    expect(route(routes, "PUT", "/api/users/[id]")).toMatchObject({ file: "pages/api/users/[id].ts", readsBody: true, hasValidation: false });
    expect(route(routes, "ANY", "/api").readsBody).toBe(false);
  });

  it("resolves `export default withAuth(handler)`", () => {
    const routes = discover({
      "/pages/api/secret.ts": "async function handler(req, res) { res.json(req.body); }\nexport default withAuth(handler);",
    });
    expect(route(routes, "ANY", "/api/secret")).toMatchObject({ hasAuth: true, readsBody: true });
  });
});

describe("discoverNextRoutes — middleware coverage", () => {
  const files = {
    "/app/api/admin/users/route.ts": "export async function POST() { return Response.json({}); }",
    "/app/api/public/route.ts": "export async function POST() { return Response.json({}); }",
    "/pages/api/admin/report.ts": "export default function handler(req, res) { res.json(req.body); }",
  };

  it("treats routes matched by an auth middleware as protected", () => {
    const routes = discover({
      ...files,
      "/middleware.ts": 'export { default } from "next-auth/middleware";\nexport const config = { matcher: ["/api/admin/:path*"] };',
    });
    expect(route(routes, "POST", "/api/admin/users").hasAuth).toBe(true);
    expect(route(routes, "ANY", "/api/admin/report").hasAuth).toBe(true);
    expect(route(routes, "POST", "/api/public").hasAuth).toBe(false);
  });

  it("covers every route when an auth middleware has no matcher (src/ or proxy.ts)", () => {
    const routes = discover({ ...files, "/src/proxy.ts": "export default clerkMiddleware();" });
    expect(routes.every((r) => r.hasAuth)).toBe(true);
  });

  it("respects negative-lookahead matchers that exclude /api", () => {
    const routes = discover({
      ...files,
      "/middleware.ts": 'export default withAuth(() => {});\nexport const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };',
    });
    expect(routes.some((r) => r.hasAuth)).toBe(false);
  });

  it("ignores middleware that does not authenticate", () => {
    const routes = discover({ ...files, "/middleware.ts": "export function middleware(req) { return i18n(req); }" });
    expect(routes.some((r) => r.hasAuth)).toBe(false);
  });
});

describe("matcherToRegExp", () => {
  it.each([
    ["/api/admin/:path*", "/api/admin", true],
    ["/api/admin/:path*", "/api/admin/a/b", true],
    ["/api/admin/:path*", "/api/administrator", false],
    ["/api/:path+", "/api", false],
    ["/api/:path+", "/api/x", true],
    ["/users/:id", "/users/x", true],
    ["/users/:id", "/users/x/y", false],
    ["/((?!api).*)", "/api/x", false],
    ["/((?!api).*)", "/dashboard", true],
  ])("%s matches %s: %s", (matcher, path, expected) => {
    expect(matcherToRegExp(matcher)?.test(path)).toBe(expected);
  });

  it("returns null for an invalid pattern", () => {
    expect(matcherToRegExp("/((?!api")).toBeNull();
  });
});
