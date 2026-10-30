import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeSvelteKitApi } from "../src/analyzers/sveltekit-api.js";
import { importsTrpcAdapter } from "../src/analyzers/trpc-syntax.js";
import { loadConfig } from "../src/config.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";

const KIT = { "@sveltejs/kit": "^2.20.0", svelte: "^5.0.0", zod: "^3.23.0" };

/** A handle hook that only populates locals, as most apps start with. */
const LOCALS_HOOK = [
  "import type { Handle } from '@sveltejs/kit';",
  "export const handle: Handle = async ({ event, resolve }) => {",
  "  event.locals.user = await findUser(event.cookies.get('session'));",
  "  return resolve(event);",
  "};",
].join("\n");

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = KIT,
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-sveltekit-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "sveltekit-fixture", dependencies }),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

async function analyze(
  files: Record<string, string>,
  dependencies: Record<string, string> = KIT,
) {
  const directory = createProject(files, dependencies);
  try {
    return await analyzeSvelteKitApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Result = Awaited<ReturnType<typeof analyze>>;

function findings(result: Result, rule: string) {
  return (result?.issues ?? [])
    .filter((issue) => issue.rule === rule)
    .map(({ message, file, line, confidence }) => ({
      message,
      file,
      line,
      confidence,
    }));
}

function messages(result: Result, rule: string): string[] {
  return findings(result, rule).map((finding) => finding.message);
}

function authMessages(result: Result): string[] {
  return messages(result, "missing-sveltekit-auth");
}

function validationMessages(result: Result): string[] {
  return messages(result, "missing-sveltekit-validation");
}

/** `if (!locals.user) error(401)` at the top of a handler. */
const REQUIRE_USER = "  if (!locals.user) error(401, 'Sign in first');";

test("detects SvelteKit apps that also depend on Node.js servers or tRPC", () => {
  const cases: Array<[Record<string, string>, Record<string, string>, string]> =
    [
      [{ "@sveltejs/kit": "^2.20.0" }, {}, "sveltekit"],
      [{ "@sveltejs/kit": "^2.20.0", express: "^5.0.0" }, {}, "sveltekit"],
      [{ "@sveltejs/kit": "^2.20.0", fastify: "^5.0.0" }, {}, "sveltekit"],
      [{ "@sveltejs/kit": "^2.20.0", hono: "^4.6.0" }, {}, "sveltekit"],
      [
        {
          "@sveltejs/kit": "^2.20.0",
          "@trpc/server": "^11.0.0",
          "trpc-sveltekit": "^3.6.0",
        },
        {},
        "sveltekit",
      ],
      // A workspace member whose kit dependency is hoisted to the root.
      [
        { svelte: "^5.0.0" },
        {
          "svelte.config.js":
            "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };",
        },
        "sveltekit",
      ],
      // Plain Svelte with Vite has a svelte.config.js too, without kit.
      [
        { svelte: "^5.0.0", vite: "^6.0.0" },
        {
          "svelte.config.js":
            "import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\nexport default { preprocess: vitePreprocess() };",
        },
        "generic",
      ],
    ];

  for (const [dependencies, files, framework] of cases) {
    const directory = createProject(files, dependencies);
    try {
      assert.equal(detectStack(directory).framework, framework);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("+server handlers are named by their route, without groups", async () => {
  const result = await analyze({
    "src/routes/+server.ts":
      "export async function POST() {\n  return new Response(null, { status: 204 });\n}",
    "src/routes/(app)/api/posts/[id]/+server.ts": [
      "import { json, type RequestHandler } from '@sveltejs/kit';",
      "export function GET() {",
      "  return json([]);",
      "}",
      "export const PATCH: RequestHandler = async ({ params }) => json({ id: params.id });",
      "export const DELETE = (async () => new Response(null)) satisfies RequestHandler;",
    ].join("\n"),
    "src/routes/files/[...path]/+server.js":
      "export function PUT({ params }) {\n  return new Response(params.path);\n}",
    "src/routes/[[lang]]/docs/[slug=word]/+server.ts":
      "const handler = () => new Response(null);\nexport { handler as POST };",
    "src/routes/api/health/+server.ts":
      "export const GET = () => new Response('ok');",
  });

  assert.deepEqual(findings(result, "missing-sveltekit-auth"), [
    {
      message: "PATCH /api/posts/[id] has no recognizable auth check",
      file: "src/routes/(app)/api/posts/[id]/+server.ts",
      line: 5,
      confidence: "high",
    },
    {
      message: "DELETE /api/posts/[id] has no recognizable auth check",
      file: "src/routes/(app)/api/posts/[id]/+server.ts",
      line: 6,
      confidence: "high",
    },
    {
      message: "POST / has no recognizable auth check",
      file: "src/routes/+server.ts",
      line: 1,
      confidence: "high",
    },
    {
      message: "POST /[[lang]]/docs/[slug=word] has no recognizable auth check",
      file: "src/routes/[[lang]]/docs/[slug=word]/+server.ts",
      line: 2,
      confidence: "high",
    },
    {
      message: "PUT /files/[...path] has no recognizable auth check",
      file: "src/routes/files/[...path]/+server.js",
      line: 1,
      confidence: "high",
    },
  ]);
  assert.deepEqual(messages(result, "missing-health-endpoint"), []);
  assert.equal(
    result?.summary,
    "7 SvelteKit endpoints and 0 form actions in 5 route files",
  );
});

test("form actions are POST endpoints named ?/name, or default", async () => {
  const result = await analyze({
    "src/routes/todos/+page.server.ts": [
      "import type { Actions } from './$types';",
      "async function archive({ request }) {",
      "  return { archived: true };",
      "}",
      "export const actions = {",
      "  create: async () => ({ created: true }),",
      "  async rename() {",
      "    return { renamed: true };",
      "  },",
      "  archive,",
      "} satisfies Actions;",
    ].join("\n"),
    "src/routes/contact/+page.server.js":
      "export const actions = {\n  default: async () => ({ sent: true }),\n};",
    "src/routes/about/+page.server.ts":
      "export const load = () => ({ title: 'About' });",
  });

  assert.deepEqual(
    findings(result, "missing-sveltekit-auth").map(({ message, line }) => ({
      message,
      line,
    })),
    [
      {
        message:
          "Default form action on /contact has no recognizable auth check",
        line: 2,
      },
      {
        message:
          "Form action ?/create on /todos has no recognizable auth check",
        line: 6,
      },
      {
        message:
          "Form action ?/rename on /todos has no recognizable auth check",
        line: 7,
      },
      {
        message:
          "Form action ?/archive on /todos has no recognizable auth check",
        line: 10,
      },
    ],
  );
});

test("a handle hook that rejects anonymous requests to a path protects its routes", async () => {
  const result = await analyze({
    "src/hooks.server.ts": [
      "import { sequence } from '@sveltejs/kit/hooks';",
      "import { authenticate, guard } from '$lib/server/hooks';",
      "export const handle = sequence(authenticate, guard);",
    ].join("\n"),
    "src/lib/server/hooks.ts": [
      "import { error, redirect, type Handle } from '@sveltejs/kit';",
      "export const authenticate: Handle = async ({ event, resolve }) => {",
      "  event.locals.user = await findUser(event.cookies.get('session'));",
      "  return resolve(event);",
      "};",
      "export const guard: Handle = async ({ event, resolve }) => {",
      "  if (event.url.pathname.startsWith('/admin') && !event.locals.user) {",
      "    redirect(303, '/login');",
      "  }",
      "  if (!event.route.id?.startsWith('/(protected)')) return resolve(event);",
      "  if (!event.locals.user) error(401, 'Sign in first');",
      "  return resolve(event);",
      "};",
    ].join("\n"),
    "src/routes/admin/users/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/(protected)/billing/+page.server.ts":
      "export const actions = {\n  default: async () => ({ ok: true }),\n};",
    "src/routes/api/feedback/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
  });

  assert.deepEqual(authMessages(result), [
    "POST /api/feedback has no recognizable auth check",
  ]);
});

test("protected path lists, loops, and early returns in a handle hook are evaluated per route", async () => {
  const result = await analyze({
    "src/hooks.server.ts": [
      "import { json, redirect, type Handle } from '@sveltejs/kit';",
      "const PUBLIC_API = ['/api/health', '/api/webhooks'] as const;",
      "const PRIVATE_PAGES = ['/settings', '/billing'];",
      "export const handle: Handle = async ({ event, resolve }) => {",
      "  event.locals.user = await findUser(event.cookies.get('session'));",
      "  if (event.locals.user) return resolve(event);",
      "  const { pathname } = event.url;",
      "  for (const prefix of PRIVATE_PAGES) {",
      "    if (pathname.startsWith(prefix)) redirect(303, '/login');",
      "  }",
      "  if (pathname.startsWith('/api') && !PUBLIC_API.some((path) => pathname.startsWith(path))) {",
      "    return json({ message: 'Unauthorized' }, { status: 401 });",
      "  }",
      "  return resolve(event);",
      "};",
    ].join("\n"),
    "src/routes/api/notes/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/api/webhooks/mailgun/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/billing/+page.server.ts":
      "export const actions = {\n  cancel: async () => ({ ok: true }),\n};",
    "src/routes/blog/+page.server.ts":
      "export const actions = {\n  comment: async () => ({ ok: true }),\n};",
  });

  assert.deepEqual(authMessages(result), [
    "POST /api/webhooks/mailgun has no recognizable auth check",
    "Form action ?/comment on /blog has no recognizable auth check",
  ]);
});

test("the Auth.js route protection pattern guards its path prefix", async () => {
  const result = await analyze({
    "src/auth.ts": [
      "import { SvelteKitAuth } from '@auth/sveltekit';",
      "import GitHub from '@auth/sveltekit/providers/github';",
      "export const { handle, signIn, signOut } = SvelteKitAuth({ providers: [GitHub] });",
    ].join("\n"),
    "src/hooks.server.ts": [
      "import { redirect, type Handle } from '@sveltejs/kit';",
      "import { sequence } from '@sveltejs/kit/hooks';",
      "import { handle as authenticationHandle } from './auth';",
      "async function authorizationHandle({ event, resolve }) {",
      "  if (event.url.pathname.startsWith('/authenticated')) {",
      "    const session = await event.locals.auth();",
      "    if (!session) {",
      "      throw redirect(303, '/auth/signin');",
      "    }",
      "  }",
      "  return resolve(event);",
      "}",
      "export const handle: Handle = sequence(authenticationHandle, authorizationHandle);",
    ].join("\n"),
    "src/routes/authenticated/notes/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/api/notes/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
  });

  assert.deepEqual(findings(result, "missing-sveltekit-auth"), [
    {
      message: "POST /api/notes has no recognizable auth check",
      file: "src/routes/api/notes/+server.ts",
      line: 1,
      confidence: "high",
    },
  ]);
});

test("handle hooks that only populate locals protect nothing", async () => {
  const route = {
    "src/routes/api/notes/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
  };
  const localsOnly = await analyze({
    "src/hooks.server.ts": LOCALS_HOOK,
    ...route,
  });
  const authJs = await analyze({
    "src/hooks.server.ts": [
      "import { SvelteKitAuth } from '@auth/sveltekit';",
      "import GitHub from '@auth/sveltekit/providers/github';",
      "export const { handle, signIn, signOut } = SvelteKitAuth({ providers: [GitHub] });",
    ].join("\n"),
    ...route,
  });

  for (const result of [localsOnly, authJs]) {
    assert.deepEqual(findings(result, "missing-sveltekit-auth"), [
      {
        message: "POST /api/notes has no recognizable auth check",
        file: "src/routes/api/notes/+server.ts",
        line: 1,
        confidence: "high",
      },
    ]);
  }
});

test("locals checks, session getters, helpers, and wrappers in handlers count as auth", async () => {
  const result = await analyze({
    "src/routes/api/a/+server.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function POST({ locals }) {",
      REQUIRE_USER,
      "  return new Response(null);",
      "}",
    ].join("\n"),
    "src/routes/api/b/+server.ts": [
      "import { redirect } from '@sveltejs/kit';",
      "export async function POST({ locals: { safeGetSession } }) {",
      "  const { session } = await safeGetSession();",
      "  if (!session) redirect(303, '/auth');",
      "  return new Response(null);",
      "}",
    ].join("\n"),
    "src/routes/api/c/+server.ts": [
      "import { error } from '@sveltejs/kit';",
      "export const DELETE = async (event) => {",
      "  const session = await event.locals.auth();",
      "  if (!session?.user) error(401);",
      "  return new Response(null);",
      "};",
    ].join("\n"),
    "src/routes/api/d/+server.ts": [
      "import { requireUser } from '$lib/server/guards';",
      "export async function PUT(event) {",
      "  const user = await requireUser(event);",
      "  return new Response(user.id);",
      "}",
    ].join("\n"),
    "src/lib/server/guards.ts": [
      "import { error } from '@sveltejs/kit';",
      "import { ensureSession } from './session';",
      "export async function requireUser(event) {",
      "  const session = await ensureSession(event);",
      "  return session.user;",
      "}",
    ].join("\n"),
    "src/lib/server/session.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function ensureSession(event) {",
      "  if (!event.locals.session) error(401, 'Sign in first');",
      "  return event.locals.session;",
      "}",
    ].join("\n"),
    // The example from the getRequestEvent() documentation.
    "src/lib/server/login.ts": [
      "import { redirect } from '@sveltejs/kit';",
      "import { getRequestEvent } from '$app/server';",
      "export function requireLogin() {",
      "  const { locals, url } = getRequestEvent();",
      "  if (!locals.user) {",
      "    const redirectTo = url.pathname + url.search;",
      "    redirect(307, `/login?${new URLSearchParams({ redirectTo })}`);",
      "  }",
      "  return locals.user;",
      "}",
    ].join("\n"),
    "src/routes/profile/+page.server.ts": [
      "import { fail } from '@sveltejs/kit';",
      "import { requireLogin } from '$lib/server/login';",
      "export const actions = {",
      "  save: async () => {",
      "    const user = requireLogin();",
      "    return { saved: user.id };",
      "  },",
      "  avatar: async ({ locals: { user } }) => {",
      "    if (!user) return fail(401);",
      "    return { ok: true };",
      "  },",
      "};",
    ].join("\n"),
    "src/routes/api/e/+server.ts": [
      "import { withAuth } from '$lib/server/with-auth';",
      "export const POST = withAuth(async ({ request }) => new Response(null));",
    ].join("\n"),
    "src/lib/server/with-auth.ts": [
      "import { error } from '@sveltejs/kit';",
      "export const withAuth = (handler) => async (event) => {",
      "  if (!event.locals.user) error(401);",
      "  return handler(event);",
      "};",
    ].join("\n"),
    "src/routes/api/webhooks/stripe/+server.ts": [
      "import { stripe } from '$lib/server/stripe';",
      "export async function POST({ request }) {",
      "  const payload = await request.text();",
      "  const event = stripe.webhooks.constructEvent(payload, request.headers.get('stripe-signature'), SECRET);",
      "  return new Response(event.id);",
      "}",
    ].join("\n"),
    "src/lib/server/stripe.ts": "export const stripe = createClient();",
    // A 404 for a missing record is not an auth check.
    "src/routes/api/posts/[id]/+server.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function DELETE({ params }) {",
      "  const post = await db.post.findUnique({ where: { id: params.id } });",
      "  if (!post) error(404);",
      "  return new Response(null);",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "DELETE /api/posts/[id] has no recognizable auth check",
  ]);
});

test("session lookups, signature headers, and plain responses count as auth checks", async () => {
  const post = (body: string[], imports: string[] = []) =>
    [
      "import { error, json } from '@sveltejs/kit';",
      ...imports,
      "export async function POST({ request, locals }) {",
      ...body,
      "  return new Response(null);",
      "}",
    ].join("\n");
  const result = await analyze({
    "src/routes/api/a/+server.ts": post(
      [
        "  const session = await getSession(request);",
        "  if (!session) return json({ error: 'Not authenticated' });",
      ],
      ["import { getSession } from 'some-auth';"],
    ),
    "src/routes/api/b/+server.ts": post(
      [
        "  const session = await getSession(request);",
        "  if (!session) return Response.redirect('/login', 302);",
      ],
      ["import { getSession } from 'some-auth';"],
    ),
    "src/routes/api/c/+server.ts": post(
      [
        "  const { user } = await getAuthenticatedUser(request);",
        "  if (!user) return json({ ok: false });",
      ],
      ["import { getAuthenticatedUser } from 'some-auth';"],
    ),
    "src/routes/api/d/+server.ts": post(
      ["  const user = await getUserOrThrow(request);"],
      ["import { getUserOrThrow } from 'some-auth';"],
    ),
    "src/routes/api/e/+server.ts": post([
      "  const signature = request.headers.get('x-hub-signature-256');",
      "  if (signature !== expected(await request.text())) error(400, 'Bad request');",
    ]),
    "src/routes/api/f/+server.ts": post([
      "  const user = locals.user ?? error(500);",
    ]),
  });

  assert.deepEqual(authMessages(result), []);
});

test("optional and rest parameters are not ruled out by exact path guards", async () => {
  const result = await analyze({
    "src/hooks.server.ts": [
      "import { redirect, type Handle } from '@sveltejs/kit';",
      "export const handle = (async ({ event, resolve }) => {",
      "  const { pathname } = event.url;",
      "  if ((pathname === '/x' || pathname === '/files') && !event.locals.user) redirect(302, '/login');",
      "  return resolve(event);",
      "}) as Handle;",
    ].join("\n"),
    "src/routes/[[lang]]/x/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/files/[...path]/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/other/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
  });

  assert.deepEqual(authMessages(result), [
    "POST /other has no recognizable auth check",
  ]);
});

test("project helpers are followed two calls deep", async () => {
  const result = await analyze({
    "src/routes/api/notes/+server.ts": [
      "import { first } from '$lib/server/chain';",
      "export async function POST(event) {",
      "  await first(event);",
      "  return new Response(null);",
      "}",
    ].join("\n"),
    "src/lib/server/chain.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function first(event) {",
      "  await second(event);",
      "}",
      "async function second(event) {",
      "  await third(event);",
      "}",
      "async function third(event) {",
      "  if (!event.locals.user) error(401);",
      "}",
    ].join("\n"),
    "src/routes/api/tags/+server.ts": [
      "import { second } from '$lib/server/short';",
      "export async function POST(event) {",
      "  await second(event);",
      "  return new Response(null);",
      "}",
    ].join("\n"),
    "src/lib/server/short.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function second(event) {",
      "  await third(event);",
      "}",
      "async function third(event) {",
      "  if (!event.locals.user) error(401);",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "POST /api/notes has no recognizable auth check",
  ]);
});

test("an auth check only in a layout or page load is named in the finding", async () => {
  const result = await analyze({
    "src/hooks.server.ts": LOCALS_HOOK,
    "src/routes/admin/+layout.server.ts": [
      "import { redirect } from '@sveltejs/kit';",
      "export const load = async ({ locals }) => {",
      "  if (!locals.user?.isAdmin) redirect(303, '/login');",
      "  return { user: locals.user };",
      "};",
    ].join("\n"),
    "src/routes/admin/users/+page.server.ts": [
      "export const load = async () => ({ users: [] });",
      "export const actions = {",
      "  delete: async () => ({ deleted: true }),",
      "};",
    ].join("\n"),
    "src/routes/admin/export/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "src/routes/settings/+page.server.ts": [
      "import { error } from '@sveltejs/kit';",
      "export async function load({ locals }) {",
      "  if (!locals.user) error(401);",
      "  return { user: locals.user };",
      "}",
      "export const actions = {",
      "  default: async () => ({ saved: true }),",
      "};",
    ].join("\n"),
  });

  assert.deepEqual(findings(result, "missing-sveltekit-auth"), [
    {
      message:
        "POST /admin/export has no recognizable auth check; the auth check in src/routes/admin/+layout.server.ts load does not run for +server endpoints",
      file: "src/routes/admin/export/+server.ts",
      line: 1,
      confidence: "high",
    },
    {
      message:
        "Form action ?/delete on /admin/users has no recognizable auth check; the auth check in src/routes/admin/+layout.server.ts load does not run for form actions",
      file: "src/routes/admin/users/+page.server.ts",
      line: 3,
      confidence: "high",
    },
    {
      message:
        "Default form action on /settings has no recognizable auth check; the auth check in src/routes/settings/+page.server.ts load does not run for form actions",
      file: "src/routes/settings/+page.server.ts",
      line: 7,
      confidence: "high",
    },
  ]);
});

test("sign-in, sign-up, and sign-out routes and actions are public by design", async () => {
  const result = await analyze({
    "src/routes/login/+page.server.ts":
      "export const actions = {\n  default: async () => ({ ok: true }),\n};",
    "src/routes/(auth)/register/+page.server.ts":
      "export const actions = {\n  default: async () => ({ ok: true }),\n};",
    "src/routes/api/auth/[...all]/+server.ts":
      "export const POST = ({ request }) => auth.handler(request);",
    "src/routes/account/+page.server.ts": [
      "export const actions = {",
      "  signout: async () => ({ ok: true }),",
      "  updateProfile: async () => ({ ok: true }),",
      "};",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "Form action ?/updateProfile on /account has no recognizable auth check",
  ]);
});

test("handlers that forward the request to another router are not judged", async () => {
  const result = await analyze({
    "src/routes/api/[...path]/+server.ts": [
      "import { app } from '$lib/server/api';",
      "export const GET = ({ request }) => app.fetch(request);",
      "export const POST = ({ request }) => app.fetch(request);",
      "export const fallback = ({ request }) => app.fetch(request);",
    ].join("\n"),
    "src/lib/server/api.ts":
      "import { Hono } from 'hono';\nexport const app = new Hono().basePath('/api');",
  });

  assert.deepEqual(authMessages(result), []);
  assert.deepEqual(validationMessages(result), []);
});

test("a fallback handler is checked like POST when it reads the body", async () => {
  const result = await analyze({
    "src/routes/api/echo/+server.ts": [
      "export async function fallback({ request }) {",
      "  return new Response(`${request.method} ok`);",
      "}",
    ].join("\n"),
    "src/routes/api/items/+server.ts": [
      "export async function fallback({ request }) {",
      "  const body = await request.json();",
      "  return new Response(JSON.stringify(body));",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), [
    "fallback /api/items has no recognizable auth check",
  ]);
  assert.deepEqual(validationMessages(result), [
    "fallback /api/items reads the request body without schema validation",
  ]);
});

test("request bodies need a schema parse or an explicit 400 check", async () => {
  const guarded = (body: string[]) =>
    [
      "import { error, fail, json } from '@sveltejs/kit';",
      "import { z } from 'zod';",
      "import * as v from 'valibot';",
      "import { superValidate } from 'sveltekit-superforms';",
      "import { zod } from 'sveltekit-superforms/adapters';",
      "import { createPost } from '$lib/server/posts';",
      "const schema = z.object({ title: z.string() });",
      "export async function POST({ request, locals }) {",
      REQUIRE_USER,
      ...body,
      "}",
    ].join("\n");

  const result = await analyze({
    "src/routes/api/raw/+server.ts": guarded([
      "  const body = await request.json();",
      "  await db.insert(posts).values(body);",
      "  return json(body);",
    ]),
    "src/routes/api/json-parse/+server.ts": guarded([
      "  const data = await request.formData();",
      "  const payload = JSON.parse(String(data.get('payload')));",
      "  return json(payload);",
    ]),
    "src/routes/api/zod/+server.ts": guarded([
      "  const parsed = schema.safeParse(await request.json());",
      "  if (!parsed.success) error(400, 'Invalid post');",
      "  return json(parsed.data);",
    ]),
    "src/routes/api/valibot/+server.ts": guarded([
      "  const body = await request.json();",
      "  const post = v.parse(PostSchema, body);",
      "  return json(post);",
    ]),
    "src/routes/api/manual/+server.ts": guarded([
      "  const { title } = await request.json();",
      "  if (typeof title !== 'string' || title.length === 0) error(400, 'title is required');",
      "  return json({ title });",
    ]),
    "src/routes/api/superforms/+server.ts": guarded([
      "  const form = await superValidate(request, zod(schema));",
      "  if (!form.valid) return fail(400, { form });",
      "  return json(form.data);",
    ]),
    "src/routes/api/helper/+server.ts": guarded([
      "  const post = await createPost(locals.user, await request.json());",
      "  return json(post);",
    ]),
    "src/routes/api/no-body/+server.ts": guarded([
      "  return json({ ok: true });",
    ]),
    "src/lib/server/posts.ts": [
      "import { z } from 'zod';",
      "const postSchema = z.object({ title: z.string() });",
      "export async function createPost(user, input) {",
      "  const data = postSchema.parse(input);",
      "  return { ...data, author: user.id };",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), []);
  assert.deepEqual(validationMessages(result), [
    "POST /api/json-parse reads the request body without schema validation",
    "POST /api/raw reads the request body without schema validation",
  ]);
});

test("form actions that read form data validate it with a schema or fail(400)", async () => {
  const result = await analyze({
    "src/hooks.server.ts": [
      "import { redirect } from '@sveltejs/kit';",
      "export async function handle({ event, resolve }) {",
      "  if (!event.locals.user && event.route.id?.startsWith('/(app)')) redirect(303, '/login');",
      "  return resolve(event);",
      "}",
    ].join("\n"),
    "src/routes/(app)/todos/+page.server.ts": [
      "import { fail } from '@sveltejs/kit';",
      "import { z } from 'zod';",
      "const idSchema = z.object({ id: z.string().uuid() });",
      "export const actions = {",
      "  create: async ({ request }) => {",
      "    const data = await request.formData();",
      "    const title = data.get('title');",
      "    if (!title) return fail(400, { title, missing: true });",
      "    return { title };",
      "  },",
      "  remove: async ({ request }) => {",
      "    const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));",
      "    if (!parsed.success) return fail(400);",
      "    return { removed: parsed.data.id };",
      "  },",
      "  rename: async ({ request }) => {",
      "    const data = await request.formData();",
      "    await db.todo.update({ where: { id: data.get('id') }, data: { title: data.get('title') } });",
      "    return { ok: true };",
      "  },",
      "};",
    ].join("\n"),
  });

  assert.deepEqual(authMessages(result), []);
  assert.deepEqual(findings(result, "missing-sveltekit-validation"), [
    {
      message:
        "Form action ?/rename on /todos reads the request body without schema validation",
      file: "src/routes/(app)/todos/+page.server.ts",
      line: 16,
      confidence: "high",
    },
  ]);
});

test("disabling the CSRF origin check in svelte.config.js is reported", async () => {
  const route = {
    "src/routes/api/health/+server.ts":
      "export const GET = () => new Response('ok');",
  };
  const checkOrigin = await analyze({
    "svelte.config.js": [
      "import adapter from '@sveltejs/adapter-node';",
      "/** @type {import('@sveltejs/kit').Config} */",
      "const config = {",
      "  kit: {",
      "    adapter: adapter(),",
      "    csrf: { checkOrigin: false },",
      "  },",
      "};",
      "export default config;",
    ].join("\n"),
    ...route,
  });
  const wildcard = await analyze({
    "svelte.config.js": [
      "export default {",
      "  kit: {",
      "    csrf: {",
      "      trustedOrigins: ['https://checkout.example.com', '*'],",
      "    },",
      "  },",
      "};",
    ].join("\n"),
    ...route,
  });
  const allowlist = await analyze({
    "svelte.config.js":
      "export default { kit: { csrf: { trustedOrigins: ['https://checkout.example.com'] } } };",
    ...route,
  });

  assert.deepEqual(findings(checkOrigin, "sveltekit-csrf-disabled"), [
    {
      message:
        "kit.csrf.checkOrigin is false, so cross-site form submissions from any origin are accepted",
      file: "svelte.config.js",
      line: 6,
      confidence: undefined,
    },
  ]);
  assert.equal(checkOrigin?.score, 80);
  assert.deepEqual(findings(wildcard, "sveltekit-csrf-disabled"), [
    {
      message:
        "kit.csrf.trustedOrigins contains '*', so cross-site form submissions from any origin are accepted",
      file: "svelte.config.js",
      line: 4,
      confidence: undefined,
    },
  ]);
  assert.deepEqual(allowlist?.issues, []);
  assert.equal(allowlist?.score, 100);
});

test("routes and hooks follow kit.files in svelte.config.js", async () => {
  const result = await analyze({
    "svelte.config.js": [
      "export default {",
      "  kit: { files: { routes: 'app/pages', hooks: { server: 'app/server-hooks' } } },",
      "};",
    ].join("\n"),
    "app/server-hooks.ts": [
      "import { error } from '@sveltejs/kit';",
      "export const handle = async ({ event, resolve }) => {",
      "  if (event.url.pathname.startsWith('/admin') && !event.locals.user) error(403);",
      "  return resolve(event);",
      "};",
    ].join("\n"),
    "app/pages/admin/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    "app/pages/api/notes/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
    // Not a route: outside the configured routes directory.
    "src/routes/api/legacy/+server.ts":
      "export async function POST() {\n  return new Response(null);\n}",
  });

  assert.deepEqual(authMessages(result), [
    "POST /api/notes has no recognizable auth check",
  ]);
});

test("a well-built endpoint scores 100 and a missing health route is reported", async () => {
  const healthy = await analyze({
    "src/routes/api/health/+server.ts":
      "import { json } from '@sveltejs/kit';\nexport const GET = () => json({ status: 'ok' });",
    "src/routes/api/notes/+server.ts": [
      "import { error, json } from '@sveltejs/kit';",
      "import { z } from 'zod';",
      "const note = z.object({ text: z.string().min(1) });",
      "export async function POST({ request, locals }) {",
      REQUIRE_USER,
      "  const parsed = note.safeParse(await request.json());",
      "  if (!parsed.success) error(400, 'Invalid note');",
      "  return json(parsed.data, { status: 201 });",
      "}",
    ].join("\n"),
  });
  const unmonitored = await analyze({
    "src/routes/api/notes/+server.ts":
      "export const GET = () => new Response('[]');",
  });

  assert.equal(healthy?.score, 100);
  assert.deepEqual(healthy?.issues, []);
  assert.deepEqual(unmonitored?.issues, [
    {
      severity: "info",
      rule: "missing-health-endpoint",
      message: "No health, readiness, or liveness endpoint detected",
      fix: "Add a lightweight GET endpoint such as src/routes/health/+server.ts for runtime monitoring",
    },
  ]);
  assert.equal(unmonitored?.score, 85);
});

test("apps without endpoints or actions have no API Health score", async () => {
  const pagesOnly = await analyze({
    "src/routes/+page.server.ts": "export const load = () => ({ posts: [] });",
    "src/routes/+page.svelte": "<h1>Blog</h1>",
  });
  const empty = await analyze({
    "src/routes/api/+server.ts": "export const prerender = true;",
  });

  assert.equal(pagesOnly, null);
  assert.deepEqual(
    empty?.issues.map(({ rule, severity, message }) => ({
      rule,
      severity,
      message,
    })),
    [
      {
        rule: "no-sveltekit-endpoints",
        severity: "critical",
        message:
          "SvelteKit +server files export no request handlers and no form actions were found",
      },
    ],
  );
  assert.equal(empty?.score, 0);
});

test("handlers the scan cannot read are counted but not judged", async () => {
  const result = await analyze({
    "src/routes/api/files/+server.ts": [
      "import { createHandlers } from 'some-file-server';",
      "export const { GET, POST } = createHandlers({ root: 'uploads' });",
    ].join("\n"),
    "src/routes/api/health/+server.ts":
      "export const GET = () => new Response('ok');",
  });

  assert.deepEqual(result?.issues, []);
  assert.equal(
    result?.summary,
    "3 SvelteKit endpoints and 0 form actions in 2 route files",
  );
});

test("unresolved project helpers lower the confidence of a finding", async () => {
  const result = await analyze({
    "src/routes/api/notes/+server.ts": [
      "import { audit } from '$lib/server/missing';",
      "export async function POST(event) {",
      "  await audit(event);",
      "  return new Response(null);",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(
    findings(result, "missing-sveltekit-auth").map(
      ({ confidence }) => confidence,
    ),
    ["low"],
  );
});

test("tRPC handlers in +server files are left to the tRPC checks", async () => {
  const result = await analyze({
    "src/routes/api/trpc/[...trpc]/+server.ts": [
      "import { fetchRequestHandler } from '@trpc/server/adapters/fetch';",
      "const handler = (event) => fetchRequestHandler({ endpoint: '/api/trpc', req: event.request, router, createContext });",
      "export const GET = handler;",
      "export const POST = handler;",
    ].join("\n"),
  });

  assert.equal(result, null);
});

test("trpc-sveltekit handles are tRPC adapters and their createContext is a perimeter", async () => {
  const directory = createProject(
    {
      "src/hooks.server.ts": [
        "import { createTRPCHandle } from 'trpc-sveltekit';",
        "import { createContext } from '$lib/trpc/context';",
        "import { router } from '$lib/trpc/router';",
        "export const handle = createTRPCHandle({ router, createContext });",
      ].join("\n"),
      "src/lib/trpc/client.ts": [
        "import { createTRPCClient } from 'trpc-sveltekit';",
        "export const trpc = () => createTRPCClient();",
      ].join("\n"),
      "src/lib/trpc/context.ts": [
        "import { TRPCError } from '@trpc/server';",
        "export async function createContext(event) {",
        "  if (!event.locals.user) throw new TRPCError({ code: 'UNAUTHORIZED' });",
        "  return { user: event.locals.user };",
        "}",
      ].join("\n"),
      "src/lib/trpc/t.ts": [
        "import { initTRPC } from '@trpc/server';",
        "export const t = initTRPC.context().create();",
      ].join("\n"),
      "src/lib/trpc/router.ts": [
        "import { z } from 'zod';",
        "import { t } from '$lib/trpc/t';",
        "export const router = t.router({",
        "  health: t.procedure.query(() => 'ok'),",
        "  addNote: t.procedure.input(z.object({ text: z.string() })).mutation(({ input }) => input),",
        "});",
      ].join("\n"),
    },
    {
      ...KIT,
      "@trpc/server": "^11.0.0",
      "trpc-sveltekit": "^3.6.0",
    },
  );

  try {
    const context = createScanContext(directory);
    const hooks = context.getSourceFile("src/hooks.server.ts");
    const client = context.getSourceFile("src/lib/trpc/client.ts");
    assert.ok(hooks && client);
    assert.equal(importsTrpcAdapter(hooks), true);
    assert.equal(importsTrpcAdapter(client), false);

    const config = loadConfig(directory);
    config.analyzers.dependencies = false;
    const result = await scan(directory, config, { interactive: false });
    const api = result.analyzers.find(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.equal(result.stack.framework, "sveltekit");
    assert.deepEqual(
      api?.issues.map((issue) => issue.rule),
      [],
    );
    assert.match(api?.summary ?? "", /2 tRPC procedures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SvelteKit cookie defaults count as httpOnly and secure", async () => {
  const directory = createProject({
    "src/lib/server/session.ts": [
      "import type { RequestEvent } from '@sveltejs/kit';",
      "export function setSessionCookie(event: RequestEvent, token: string, expires: Date) {",
      "  event.cookies.set('session', token, { expires, path: '/' });",
      "}",
      "export function exposeSessionCookie(event: RequestEvent, token: string) {",
      "  event.cookies.set('session', token, { httpOnly: false, path: '/' });",
      "}",
    ].join("\n"),
    "src/routes/api/health/+server.ts":
      "export const GET = () => new Response('ok');",
  });

  try {
    const config = loadConfig(directory);
    config.analyzers.dependencies = false;
    const result = await scan(directory, config, { interactive: false });
    const cookies = result.analyzers
      .flatMap((analyzer) => analyzer.issues)
      .filter((issue) => issue.rule === "insecure-cookie")
      .map(({ message, line }) => ({ message, line }));
    assert.deepEqual(cookies, [
      { message: 'Cookie "session" is set without httpOnly', line: 6 },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
