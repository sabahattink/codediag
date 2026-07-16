import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeNextjsApi } from "../src/analyzers/nextjs-api.js";
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
    const result = await analyzeNextjsApi(directory);
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
    const result = await analyzeNextjsApi(directory);
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
    const result = await analyzeNextjsApi(directory);
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
    assert.equal(await analyzeNextjsApi(directory), null);
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
