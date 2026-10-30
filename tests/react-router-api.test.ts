import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeReactRouterApi } from "../src/analyzers/react-router-api.js";
import { flatRoutePath } from "../src/analyzers/react-router-routes.js";
import { createScanContext } from "../src/core/scan-context.js";
import { detectStack } from "../src/detectors/stack-detector.js";
import { scan } from "../src/scanner.js";
import type { AnalyzerResult } from "../src/types.js";

const REACT_ROUTER = {
  "@react-router/dev": "^7.9.0",
  "@react-router/node": "^7.9.0",
  "react-router": "^7.9.0",
};
const REMIX = {
  "@remix-run/dev": "^2.15.0",
  "@remix-run/node": "^2.15.0",
  "@remix-run/react": "^2.15.0",
};
const ROUTE_HELPERS =
  'import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";';

function createProject(
  files: Record<string, string>,
  dependencies: Record<string, string> = REACT_ROUTER,
): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-react-router-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "react-router-fixture", dependencies }),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

async function analyzeOrNull(
  files: Record<string, string>,
  dependencies?: Record<string, string>,
): Promise<AnalyzerResult | null> {
  const directory = createProject(files, dependencies);
  try {
    return await analyzeReactRouterApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function analyze(
  files: Record<string, string>,
  dependencies?: Record<string, string>,
): Promise<AnalyzerResult> {
  const result = await analyzeOrNull(files, dependencies);
  assert.ok(result, "expected an API Health result");
  return result;
}

function messages(result: AnalyzerResult, rule: string): string[] {
  return result.issues
    .filter((issue) => issue.rule === rule)
    .map((issue) => issue.message);
}

const UNPROTECTED_ACTION = [
  "export async function action() {",
  "  return null;",
  "}",
].join("\n");

const UNPROTECTED = "has no recognizable auth check";

test("detects React Router framework mode and Remix, but not library-mode SPAs", () => {
  const cases: Array<[Record<string, string>, Record<string, string>, string]> =
    [
      [
        { "react-router": "^7.9.0", "@react-router/dev": "^7.9.0" },
        {},
        "react-router",
      ],
      [
        {
          "react-router": "^7.9.0",
          "@react-router/node": "^7.9.0",
          "@react-router/serve": "^7.9.0",
        },
        {},
        "react-router",
      ],
      [
        {
          "react-router": "^7.9.0",
          "@react-router/express": "^7.9.0",
          express: "^5.0.0",
        },
        {},
        "react-router",
      ],
      [REMIX, {}, "react-router"],
      [
        {
          "@remix-run/express": "^2.15.0",
          "@remix-run/react": "^2.15.0",
          express: "^4.21.0",
        },
        {},
        "react-router",
      ],
      [
        { "react-router": "^7.9.0", react: "^19.0.0" },
        {
          "app/routes.ts": `${ROUTE_HELPERS}\nexport default [index("routes/home.tsx")] satisfies RouteConfig;`,
        },
        "react-router",
      ],
      [{ "react-router-dom": "^6.28.0", react: "^18.3.1" }, {}, "generic"],
      [{ "react-router": "^7.9.0", react: "^19.0.0" }, {}, "generic"],
      [
        { "react-router-dom": "^6.28.0", "@remix-run/router": "^1.21.0" },
        {},
        "generic",
      ],
      [{ "react-router-dom": "^6.28.0", express: "^5.0.0" }, {}, "express"],
      [{ next: "^15.0.0", ...REACT_ROUTER }, {}, "nextjs"],
    ];

  for (const [dependencies, files, framework] of cases) {
    const directory = createProject(files, dependencies);
    try {
      assert.equal(
        detectStack(directory).framework,
        framework,
        JSON.stringify(dependencies),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("flat route file names map to URL paths", () => {
  const cases: Array<[string, string]> = [
    ["_index", "/"],
    ["about", "/about"],
    ["concerts.trending", "/concerts/trending"],
    ["concerts.$city", "/concerts/:city"],
    ["concerts._index", "/concerts"],
    ["concerts_.mine", "/concerts/mine"],
    ["_auth.login", "/login"],
    ["($lang).categories", "/:lang?/categories"],
    ["($lang)._index", "/:lang?"],
    ["($lang).$productId", "/:lang?/:productId"],
    ["files.$", "/files/*"],
    ["$", "/*"],
    ["sitemap[.]xml", "/sitemap.xml"],
    ["[sitemap.xml]", "/sitemap.xml"],
    ["weird-url.[_index]", "/weird-url/_index"],
    ["dolla-bills-[$]", "/dolla-bills-$"],
    ["[[so-weird]]", "/[so-weird]"],
    ["reports.$id[.pdf]", "/reports/:id.pdf"],
    ["app_.projects.$id.roadmap", "/app/projects/:id/roadmap"],
  ];

  for (const [name, path] of cases) {
    assert.equal(flatRoutePath(name), path, name);
  }
});

test("routes.ts resolves route, index, layout, and prefix paths", async () => {
  const result = await analyze({
    "app/routes.ts": [
      ROUTE_HELPERS,
      'import { adminRoutes } from "./admin-routes";',
      "export default [",
      '  index("routes/home.tsx"),',
      '  route("teams/:teamId", "routes/team.tsx", [',
      '    index("routes/team-home.tsx"),',
      '    route("members", "routes/members.tsx", { id: "team-members" }, []),',
      "  ]),",
      '  layout("routes/marketing.tsx", [route("contact", "routes/contact.tsx")]),',
      '  ...prefix("api", [',
      '    index("routes/api-index.ts"),',
      '    route("notes/:noteId", "./routes/api-note.ts"),',
      '    layout("routes/api-layout.ts", [route("ping", "routes/ping.ts")]),',
      "  ]),",
      '  ...prefix("admin", adminRoutes),',
      "] satisfies RouteConfig;",
    ].join("\n"),
    "app/admin-routes.ts": [
      'import { route } from "@react-router/dev/routes";',
      'export const adminRoutes = [route("users", "routes/admin-users.tsx")];',
    ].join("\n"),
    "app/routes/home.tsx": UNPROTECTED_ACTION,
    "app/routes/team.tsx": UNPROTECTED_ACTION,
    "app/routes/team-home.tsx": UNPROTECTED_ACTION,
    "app/routes/members.tsx": UNPROTECTED_ACTION,
    "app/routes/marketing.tsx": "export default function Marketing() {}",
    "app/routes/contact.tsx": UNPROTECTED_ACTION,
    "app/routes/api-index.ts": UNPROTECTED_ACTION,
    "app/routes/api-note.ts": UNPROTECTED_ACTION,
    "app/routes/api-layout.ts": "export default function ApiLayout() {}",
    "app/routes/ping.ts": UNPROTECTED_ACTION,
    "app/routes/admin-users.tsx": UNPROTECTED_ACTION,
    "app/routes/orphan.tsx": UNPROTECTED_ACTION,
  });

  assert.deepEqual(
    messages(result, "missing-react-router-auth").sort(),
    [
      "/",
      "/admin/users",
      "/api",
      "/api/notes/:noteId",
      "/api/ping",
      "/contact",
      "/teams/:teamId",
      "/teams/:teamId",
      "/teams/:teamId/members",
    ].map((path) => `The action of ${path} ${UNPROTECTED}`),
  );
  const home = result.issues.find((issue) =>
    issue.message.startsWith("The action of / "),
  );
  assert.equal(home?.file, "app/routes/home.tsx");
  assert.equal(home?.line, 1);
  assert.equal(home?.confidence, "high");
});

test("flat routes nest by file name and folders define route modules", async () => {
  const result = await analyze(
    {
      "app/root.tsx": "export default function App() {}",
      "app/routes/_index.tsx": UNPROTECTED_ACTION,
      "app/routes/concerts.$city.tsx": UNPROTECTED_ACTION,
      "app/routes/concerts_.mine.tsx": UNPROTECTED_ACTION,
      "app/routes/_marketing.pricing.tsx": UNPROTECTED_ACTION,
      "app/routes/app.projects/route.tsx": UNPROTECTED_ACTION,
      "app/routes/app.projects/project-card.tsx": UNPROTECTED_ACTION,
      "app/routes/settings/index.tsx": UNPROTECTED_ACTION,
      "app/routes/files.$.tsx": UNPROTECTED_ACTION,
      "app/routes/notes.test.tsx": UNPROTECTED_ACTION,
      "app/routes/styles.css": "body {}",
      "app/components/form.tsx": UNPROTECTED_ACTION,
    },
    REMIX,
  );

  assert.deepEqual(
    messages(result, "missing-react-router-auth").sort(),
    [
      "/",
      "/app/projects",
      "/concerts/:city",
      "/concerts/mine",
      "/files/*",
      "/pricing",
      "/settings",
    ].map((path) => `The action of ${path} ${UNPROTECTED}`),
  );
});

test("resource routes are endpoints; clientAction and clientLoader are not", async () => {
  const result = await analyze({
    "app/routes.ts": [
      ROUTE_HELPERS,
      "export default [",
      '  route("api/notes", "routes/api.notes.ts"),',
      '  route("drafts", "routes/drafts.tsx"),',
      "] satisfies RouteConfig;",
    ].join("\n"),
    "app/routes/api.notes.ts": [
      "export const loader = async () => Response.json([]);",
      "export const action = async ({ request }) => {",
      "  const body = await request.json();",
      "  return Response.json(body, { status: 201 });",
      "};",
    ].join("\n"),
    "app/routes/drafts.tsx": [
      "export async function clientLoader() {",
      "  return JSON.parse(localStorage.getItem('drafts') ?? '[]');",
      "}",
      "export async function clientAction({ request }) {",
      "  const formData = await request.formData();",
      "  localStorage.setItem('drafts', JSON.stringify([...formData]));",
      "  return null;",
      "}",
      "export default function Drafts() {}",
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues.map(({ rule, message, line }) => ({ rule, message, line })),
    [
      {
        rule: "missing-react-router-auth",
        message: `The action of /api/notes ${UNPROTECTED}`,
        line: 2,
      },
      {
        rule: "missing-react-router-validation",
        message:
          "The action of /api/notes reads request.json() without schema validation",
        line: 3,
      },
      {
        rule: "missing-health-endpoint",
        message: "No health, readiness, or liveness endpoint detected",
        line: undefined,
      },
    ],
  );
  assert.equal(
    result.summary,
    "2 React Router endpoints (1 action, 1 loader) in 2 route modules",
  );
});

test("route modules without loaders or actions leave API Health not applicable", async () => {
  const result = await analyzeOrNull({
    "app/root.tsx": "export default function App() {}",
    "app/routes.ts": `${ROUTE_HELPERS}\nexport default [index("routes/home.tsx")] satisfies RouteConfig;`,
    "app/routes/home.tsx": [
      "export function clientLoader() { return null; }",
      "export default function Home() {}",
    ].join("\n"),
  });

  assert.equal(result, null);
});

test("reports a project with no route modules", async () => {
  const result = await analyze({ "src/index.ts": "export {};" });

  assert.equal(result.score, 0);
  assert.deepEqual(
    result.issues.map(({ rule, message }) => ({ rule, message })),
    [
      {
        rule: "no-react-router-routes",
        message: "No React Router route modules were detected",
      },
    ],
  );
});

test("middleware that rejects anonymous requests protects every child route", async () => {
  const result = await analyze({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, paths: { "~/*": ["./app/*"] } },
    }),
    "app/routes.ts": [
      ROUTE_HELPERS,
      "export default [",
      '  layout("routes/protected.tsx", [',
      '    route("admin/users/:id", "routes/admin-user.tsx"),',
      '    layout("routes/nested.tsx", [route("reports", "routes/reports.tsx")]),',
      "  ]),",
      '  layout("routes/legacy.tsx", [route("legacy", "routes/legacy-page.tsx")]),',
      '  route("public", "routes/public.tsx"),',
      "] satisfies RouteConfig;",
    ].join("\n"),
    "app/middleware/auth.server.ts": [
      'import { redirect } from "react-router";',
      'import { userContext } from "~/context";',
      'import { getUser } from "~/session.server";',
      "export async function sessionGate({ request, context }) {",
      "  const user = await getUser(request);",
      '  if (!user) throw redirect("/login");',
      "  context.set(userContext, user);",
      "}",
    ].join("\n"),
    "app/routes/protected.tsx": [
      'import { sessionGate } from "~/middleware/auth.server";',
      "export const middleware = [sessionGate];",
      "export default function Protected() {}",
    ].join("\n"),
    "app/routes/nested.tsx": "export default function Nested() {}",
    "app/routes/admin-user.tsx": UNPROTECTED_ACTION,
    "app/routes/reports.tsx": [
      "export async function loader() { return listReports(); }",
      UNPROTECTED_ACTION,
    ].join("\n"),
    "app/routes/legacy.tsx": [
      'import { redirect } from "react-router";',
      "export const unstable_middleware = [",
      "  async ({ request }) => {",
      "    const session = await getSession(request.headers.get('Cookie'));",
      "    if (!session.has('userId')) throw redirect('/login');",
      "  },",
      "];",
      "export default function Legacy() {}",
    ].join("\n"),
    "app/routes/legacy-page.tsx": UNPROTECTED_ACTION,
    "app/routes/public.tsx": UNPROTECTED_ACTION,
  });

  assert.deepEqual(messages(result, "missing-react-router-auth"), [
    `The action of /public ${UNPROTECTED}`,
  ]);
  assert.deepEqual(messages(result, "react-router-loader-auth-only"), []);
});

test("auth only in a loader does not protect child actions and loaders", async () => {
  const result = await analyze(
    {
      "app/session.server.ts": [
        'import { redirect } from "@remix-run/node";',
        "export async function requireUserId(request) {",
        "  const userId = await getUserId(request);",
        '  if (!userId) throw redirect("/login");',
        "  return userId;",
        "}",
      ].join("\n"),
      "app/routes/_app.tsx": [
        'import { requireUserId } from "../session.server";',
        "export async function loader({ request }) {",
        "  return { userId: await requireUserId(request) };",
        "}",
        "export default function AppLayout() {}",
      ].join("\n"),
      "app/routes/_app.notes.tsx": [
        "export async function loader() {",
        "  return { notes: await db.note.findMany() };",
        "}",
        "export default function Notes() {}",
      ].join("\n"),
      "app/routes/_app.notes.$noteId.tsx": [
        'import { requireUserId } from "../session.server";',
        "export async function loader({ request, params }) {",
        "  const userId = await requireUserId(request);",
        "  return db.note.find({ id: params.noteId, userId });",
        "}",
        "export async function action({ params }) {",
        "  await db.note.delete({ id: params.noteId });",
        '  return redirect("/notes");',
        "}",
        "export default function Note() {}",
      ].join("\n"),
      "app/routes/_app.settings.tsx": [
        "export async function action({ request }) {",
        '  await db.settings.reset({ intent: "reset" });',
        "  return null;",
        "}",
        "export default function Settings() {}",
      ].join("\n"),
      "app/routes/_app._index.tsx":
        'export const loader = () => redirect("/notes");',
      "app/routes/_app.help.tsx": [
        'export const loader = () => ({ title: "Help", sections: ["faq", 2] });',
        "export default function Help() {}",
      ].join("\n"),
      "app/routes/_app.healthz.ts":
        'export const loader = () => new Response("ok");',
    },
    REMIX,
  );

  assert.deepEqual(messages(result, "missing-react-router-auth"), []);
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "react-router-loader-auth-only")
      .map(({ message, file, line, confidence }) => ({
        message,
        file,
        line,
        confidence,
      })),
    [
      {
        message:
          "The action of /notes/:noteId has no auth check of its own; the auth check in its route's loader does not run before the action",
        file: "app/routes/_app.notes.$noteId.tsx",
        line: 6,
        confidence: "high",
      },
      {
        message:
          "The action of /settings has no auth check of its own; the auth check in the loader of app/routes/_app.tsx does not run before the action",
        file: "app/routes/_app.settings.tsx",
        line: 1,
        confidence: "high",
      },
      {
        message:
          "The loader of /notes has no auth check of its own; the auth check in the loader of app/routes/_app.tsx runs in parallel and does not protect it",
        file: "app/routes/_app.notes.tsx",
        line: 1,
        confidence: "medium",
      },
    ],
  );
});

test("auth helpers are followed two calls deep", async () => {
  const result = await analyze({
    "app/lib/session.server.ts": [
      'import { createCookieSessionStorage, redirect } from "react-router";',
      "const storage = createCookieSessionStorage({ cookie: { name: '__session' } });",
      "export async function readAccountId(request) {",
      "  const session = await storage.getSession(request.headers.get('Cookie'));",
      "  const accountId = session.get('accountId');",
      "  if (!accountId) throw redirect('/login');",
      "  return accountId;",
      "}",
    ].join("\n"),
    "app/lib/account.server.ts": [
      'import { readAccountId } from "./session.server";',
      "export async function currentAccount(request) {",
      "  const id = await readAccountId(request);",
      "  return db.account.find(id);",
      "}",
    ].join("\n"),
    "app/lib/workspace.server.ts": [
      'import { currentAccount } from "./account.server";',
      "export const loadWorkspace = async (request) => currentAccount(request);",
    ].join("\n"),
    "app/routes/shallow.tsx": [
      'import { currentAccount } from "../lib/account.server";',
      "export async function action({ request }) {",
      "  const account = await currentAccount(request);",
      "  return account.id;",
      "}",
    ].join("\n"),
    "app/routes/deep.tsx": [
      'import { loadWorkspace } from "../lib/workspace.server";',
      "export async function action({ request }) {",
      "  const workspace = await loadWorkspace(request);",
      "  return workspace.id;",
      "}",
    ].join("\n"),
    "app/routes/opaque.tsx": [
      'import { getAuth } from "@clerk/react-router/ssr.server";',
      "export async function action(args) {",
      "  const { userId } = await getAuth(args);",
      "  return userId;",
      "}",
    ].join("\n"),
    // currentAccount is first reached at the depth limit through
    // loadWorkspace, then called directly, where its check is in reach.
    "app/routes/revisited.tsx": [
      'import { currentAccount } from "../lib/account.server";',
      'import { loadWorkspace } from "../lib/workspace.server";',
      "export async function action({ request }) {",
      "  const workspace = await loadWorkspace(request);",
      "  const account = await currentAccount(request);",
      "  return { workspace, account };",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "missing-react-router-auth")
      .map(({ message, confidence }) => ({ message, confidence })),
    [
      { message: `The action of /deep ${UNPROTECTED}`, confidence: "medium" },
      { message: `The action of /opaque ${UNPROTECTED}`, confidence: "medium" },
    ],
  );
});

test("recognizes session, remix-auth, Response, data, and context auth checks", async () => {
  const action = (body: string[]) =>
    [
      "export async function action({ request, context }) {",
      ...body.map((line) => `  ${line}`),
      "  return null;",
      "}",
    ].join("\n");
  const result = await analyze({
    "app/routes/session.tsx": action([
      "const session = await getSession(request.headers.get('Cookie'));",
      "if (!session.has('userId')) throw redirect('/login');",
    ]),
    "app/routes/remix-auth.tsx": action([
      "await authenticator.isAuthenticated(request, { failureRedirect: '/login' });",
    ]),
    "app/routes/response.tsx": action([
      "const user = await getUser(request);",
      "if (!user) {",
      "  throw new Response(null, { status: 401 });",
      "}",
    ]),
    "app/routes/data.tsx": action([
      "const userId = await getUserId(request);",
      "if (!userId) throw data({ message: 'Unauthorized' }, { status: 401 });",
    ]),
    "app/routes/equals-null.tsx": action([
      "const user = await getUser(request);",
      "if (user == null) return redirect('/login');",
    ]),
    "app/routes/context.tsx": action([
      "const user = context.get(userContext);",
    ]),
    "app/routes/require.tsx": action(["await requireUserId(request);"]),
    "app/routes/wrapped.tsx": [
      "export const action = withAuth(async ({ request }) => {",
      "  return null;",
      "});",
    ].join("\n"),
    "app/routes/toast.tsx": action([
      "const userId = await getUserId(request);",
      "if (!userId) return redirectWithToast('/login', { title: 'Sign in first' });",
    ]),
    "app/routes/invariant.tsx": action([
      "const user = await getUser(request);",
      "invariantResponse(user, 'Unauthorized', { status: 401 });",
    ]),
    "app/routes/bearer.tsx": action([
      "if (request.headers.get('Authorization') !== `Bearer ${env.API_TOKEN}`) {",
      "  throw new Response(null, { status: 401 });",
      "}",
    ]),
    "app/routes/stripe-webhook.tsx": action([
      "const payload = await request.text();",
      "const event = stripe.webhooks.constructEvent(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);",
    ]),
    "app/routes/svix-webhook.tsx": action([
      "const event = new Webhook(env.WEBHOOK_SECRET).verify(await request.text(), Object.fromEntries(request.headers));",
    ]),
    "app/routes/optional-user.tsx": action([
      "const user = await getOptionalUser(request);",
      "if (user) await trackVisit(user.id);",
    ]),
    "app/routes/not-found.tsx": action([
      "const note = await db.note.find(request.url);",
      "if (!note) throw new Response('Not found', { status: 404 });",
      "if (note.status !== 'draft') throw new Response('Gone', { status: 410 });",
    ]),
  });

  assert.deepEqual(messages(result, "missing-react-router-auth"), [
    `The action of /not-found ${UNPROTECTED}`,
    `The action of /optional-user ${UNPROTECTED}`,
  ]);
});

test("re-exported handlers and middleware are followed; clientMiddleware is not a perimeter", async () => {
  const result = await analyze({
    "app/routes.ts": [
      ROUTE_HELPERS,
      "export default [",
      '  layout("routes/account.tsx", [route("account", "routes/account-home.tsx")]),',
      '  layout("routes/browser-only.tsx", [route("drafts", "routes/drafts.tsx")]),',
      '  route("billing", "routes/billing.tsx"),',
      "] satisfies RouteConfig;",
    ].join("\n"),
    "app/middleware.server.ts": [
      "async function signedIn({ request }) {",
      "  const user = await getUser(request);",
      "  if (!user) throw redirect('/login');",
      "}",
      "export const middleware = [signedIn];",
    ].join("\n"),
    "app/routes/account.tsx": [
      'export { middleware } from "../middleware.server";',
      "export default function Account() {}",
    ].join("\n"),
    "app/routes/account-home.tsx": UNPROTECTED_ACTION,
    "app/routes/browser-only.tsx": [
      "export const clientMiddleware = [",
      "  async () => {",
      "    if (!localStorage.getItem('user')) throw redirect('/login');",
      "  },",
      "];",
      "export default function BrowserOnly() {}",
    ].join("\n"),
    "app/routes/drafts.tsx": UNPROTECTED_ACTION,
    "app/billing.server.ts": UNPROTECTED_ACTION,
    "app/routes/billing.tsx": [
      "// The action lives with the billing service.",
      'export { action } from "../billing.server";',
      "export default function Billing() {}",
    ].join("\n"),
  });

  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "missing-react-router-auth")
      .map(({ message, file, line }) => ({ message, file, line })),
    [
      {
        message: `The action of /billing ${UNPROTECTED}`,
        file: "app/routes/billing.tsx",
        line: 2,
      },
      {
        message: `The action of /drafts ${UNPROTECTED}`,
        file: "app/routes/drafts.tsx",
        line: 1,
      },
    ],
  );
});

test("a route config that cannot be read statically leaves API Health not applicable", async () => {
  const adapter = await analyzeOrNull({
    "app/root.tsx": [
      "export async function loader() { return null; }",
      "export default function App() {}",
    ].join("\n"),
    "app/routes.ts": [
      'import { type RouteConfig } from "@react-router/dev/routes";',
      'import { remixRoutesOptionAdapter } from "@react-router/remix-routes-option-adapter";',
      'import { flatRoutes } from "remix-flat-routes";',
      "export default remixRoutesOptionAdapter((defineRoutes) =>",
      '  flatRoutes("routes", defineRoutes),',
      ") satisfies RouteConfig;",
    ].join("\n"),
    "app/routes/_auth+/login.tsx": UNPROTECTED_ACTION,
  });
  const plusFolders = await analyzeOrNull(
    {
      "app/root.tsx": "export default function App() {}",
      "app/routes/_marketing+/index.tsx": UNPROTECTED_ACTION,
      "app/routes/users+/$username.tsx": UNPROTECTED_ACTION,
    },
    REMIX,
  );

  assert.equal(adapter, null);
  assert.equal(plusFolders, null);
});

test("sign-in, sign-up, and sign-out actions are not reported as missing auth", async () => {
  const result = await analyze({
    "app/routes/login.tsx": [
      'import { createUserSession } from "../session.server";',
      "export async function action({ request }) {",
      "  const form = LoginSchema.parse(Object.fromEntries(await request.formData()));",
      "  const user = await verifyLogin(form.email, form.password);",
      "  return createUserSession({ request, userId: user.id });",
      "}",
    ].join("\n"),
    "app/routes/join.tsx": [
      "export async function action({ request }) {",
      "  const form = JoinSchema.parse(Object.fromEntries(await request.formData()));",
      "  const user = await createUser(form);",
      "  const session = await getSession();",
      '  session.set("userId", user.id);',
      '  return redirect("/", { headers: { "Set-Cookie": await commitSession(session) } });',
      "}",
    ].join("\n"),
    "app/routes/logout.ts": [
      "export async function action({ request }) {",
      "  const session = await getSession(request.headers.get('Cookie'));",
      '  return redirect("/", { headers: { "Set-Cookie": await destroySession(session) } });',
      "}",
    ].join("\n"),
    "app/routes/auth.$provider.callback.ts": UNPROTECTED_ACTION,
    "app/routes/forgot-password.tsx": UNPROTECTED_ACTION,
    "app/routes/contact.tsx": UNPROTECTED_ACTION,
  });

  assert.deepEqual(messages(result, "missing-react-router-auth"), [
    `The action of /contact ${UNPROTECTED}`,
  ]);
});

test("actions that read the request body need schema validation", async () => {
  const action = (body: string[]) =>
    [
      "export async function action({ request }) {",
      "  await requireUserId(request);",
      ...body.map((line) => `  ${line}`),
      "  return null;",
      "}",
    ].join("\n");
  const result = await analyze({
    "app/lib/notes.server.ts": [
      "export async function createNoteFromForm(formData) {",
      "  return NoteSchema.parse(Object.fromEntries(formData));",
      "}",
    ].join("\n"),
    "app/routes/zod.tsx": action([
      "const note = NoteSchema.parse(Object.fromEntries(await request.formData()));",
    ]),
    "app/routes/safe-parse.tsx": action([
      "const result = NoteSchema.safeParse(await request.json());",
    ]),
    "app/routes/zfd.tsx": action([
      "const schema = zfd.formData({ title: zfd.text() });",
      "const note = schema.parse(await request.formData());",
    ]),
    "app/routes/conform.tsx": action([
      "const formData = await request.formData();",
      "const submission = parseWithZod(formData, { schema: NoteSchema });",
    ]),
    "app/routes/hook-form.tsx": action([
      "const { errors, data } = await getValidatedFormData(request, resolver);",
    ]),
    "app/routes/validated-form.tsx": action([
      "const result = await validator.validate(await request.formData());",
    ]),
    "app/routes/valibot.tsx": action([
      "const note = v.parse(NoteSchema, await request.json());",
    ]),
    "app/routes/valibot-function.tsx": action([
      "const result = safeParse(NoteSchema, await request.json());",
    ]),
    "app/routes/yup.tsx": action([
      "const note = await noteSchema.validate(await request.json());",
    ]),
    "app/routes/arktype.tsx": action([
      "const note = Note(await request.json());",
      "if (note instanceof type.errors) return data(note.summary, { status: 400 });",
    ]),
    "app/routes/manual.tsx": action([
      "const formData = await request.formData();",
      "const title = formData.get('title');",
      "if (typeof title !== 'string' || title.length === 0) return data({ title: 'Required' }, { status: 400 });",
    ]),
    "app/routes/intent.tsx": action([
      "const formData = await request.formData();",
      "if (formData.get('intent') === 'archive') await archiveNote();",
    ]),
    "app/routes/helper.tsx": [
      'import { createNoteFromForm } from "../lib/notes.server";',
      action(["await createNoteFromForm(await request.formData());"]),
    ].join("\n"),
    "app/routes/unchecked.tsx": action([
      "const formData = await request.formData();",
      "const title = formData.get('title') as string;",
      "await db.note.create({ data: { title } });",
    ]),
    "app/routes/raw-json.tsx": action([
      "const body = await request.json();",
      "const count = Number.parseInt(body.count, 10);",
      "await db.note.update(JSON.parse(JSON.stringify({ ...body, count })));",
    ]),
  });

  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "missing-react-router-validation")
      .map(({ message, file, line }) => ({ message, file, line })),
    [
      {
        message:
          "The action of /raw-json reads request.json() without schema validation",
        file: "app/routes/raw-json.tsx",
        line: 3,
      },
      {
        message:
          "The action of /unchecked reads request.formData() without schema validation",
        file: "app/routes/unchecked.tsx",
        line: 3,
      },
    ],
  );
  assert.deepEqual(messages(result, "missing-react-router-auth"), []);
});

test("a health resource route counts as a health endpoint", async () => {
  const result = await analyze(
    {
      "app/routes/api.healthz.ts": [
        "export async function loader() {",
        '  return Response.json({ status: "ok" });',
        "}",
      ].join("\n"),
    },
    REMIX,
  );

  assert.deepEqual(result.issues, []);
  assert.equal(result.score, 100);
});

test("flatRoutes() in routes.ts reads its root directory and ignored files", async () => {
  const result = await analyze({
    "react-router.config.ts": [
      'import type { Config } from "@react-router/dev/config";',
      'export default { appDirectory: "src", future: { v8_middleware: true } } satisfies Config;',
    ].join("\n"),
    "src/routes.ts": [
      ROUTE_HELPERS,
      'import { flatRoutes } from "@react-router/fs-routes";',
      "export default [",
      '  route("/", "home.tsx"),',
      '  ...(await flatRoutes({ rootDirectory: "file-routes", ignoredRouteFiles: ["**/*.server.ts"] })),',
      "] satisfies RouteConfig;",
    ].join("\n"),
    "src/home.tsx": UNPROTECTED_ACTION,
    "src/file-routes/projects.$id.tsx": UNPROTECTED_ACTION,
    "src/file-routes/queries.server.ts": UNPROTECTED_ACTION,
    "src/routes/not-a-route.tsx": UNPROTECTED_ACTION,
    "app/routes/not-a-route-either.tsx": UNPROTECTED_ACTION,
  });

  assert.deepEqual(
    messages(result, "missing-react-router-auth").sort(),
    ["/", "/projects/:id"].map(
      (path) => `The action of ${path} ${UNPROTECTED}`,
    ),
  );
});

test("scanner runs API Health analysis for React Router projects", async () => {
  const directory = createProject({
    "app/root.tsx": "export default function App() {}",
    "app/routes.ts": `${ROUTE_HELPERS}\nexport default [route("healthz", "routes/healthz.ts")] satisfies RouteConfig;`,
    "app/routes/healthz.ts": "export const loader = () => new Response('ok');",
  });

  try {
    const result = await scan(directory, undefined, { interactive: false });
    assert.equal(result.stack.framework, "react-router");
    const api = result.analyzers.filter(
      (analyzer) => analyzer.name === "API Health",
    );
    assert.equal(api.length, 1);
    assert.equal(
      api[0]?.summary,
      "1 React Router endpoint (0 actions, 1 loader) in 2 route modules",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
