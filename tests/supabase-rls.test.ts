import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { supabaseRlsIssues } from "../src/analyzers/supabase-rls.js";
import { loadConfig } from "../src/config.js";
import { createScanContext } from "../src/core/scan-context.js";
import { scan } from "../src/scanner.js";

const INIT = "supabase/migrations/20240101000000_init.sql";
const LATER = "supabase/migrations/20240201000000_later.sql";

function createProject(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-supabase-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
}

function withProject<T>(
  files: Record<string, string>,
  run: (directory: string) => T,
): T {
  const directory = createProject(files);
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function findings(files: Record<string, string>) {
  return withProject(files, (directory) =>
    supabaseRlsIssues(createScanContext(directory)).issues.map(
      ({ rule, severity, file, line, message }) => ({
        rule,
        severity,
        file,
        line,
        message,
      }),
    ),
  );
}

const TODOS = [
  "create table public.todos (",
  "  id bigint generated always as identity primary key,",
  "  user_id uuid references auth.users not null,",
  "  task text",
  ");",
].join("\n");

test("a table in an exposed schema without row level security is critical", () => {
  assert.deepEqual(findings({ [INIT]: `-- Todos\n${TODOS}\n` }), [
    {
      rule: "supabase-table-without-rls",
      severity: "critical",
      file: INIT,
      line: 2,
      message:
        "Table public.todos is exposed through the Supabase API without row level security, so anyone with the anon key can read and write it",
    },
  ]);
});

test("row level security enabled in the same or a later migration clears the finding", () => {
  assert.deepEqual(
    findings({
      [INIT]: `${TODOS}\nalter table todos enable row level security;\n`,
    }),
    [],
  );
  assert.deepEqual(
    findings({
      [INIT]: TODOS,
      [LATER]: "ALTER TABLE ONLY public.todos ENABLE ROW LEVEL SECURITY;",
    }),
    [],
  );
  // Disabling it again brings the finding back.
  assert.equal(
    findings({
      [INIT]: `${TODOS}\nalter table todos enable row level security;`,
      [LATER]: "alter table if exists public.todos disable row level security;",
    }).length,
    1,
  );
});

test("renamed, moved, and dropped tables are followed", () => {
  assert.deepEqual(
    findings({
      [INIT]: [
        "create table notes (id int);",
        "alter table notes rename to memos;",
        "alter table public.memos enable row level security;",
        "create table drafts (id int);",
        "drop table if exists drafts, other cascade;",
        "create table archive (id int);",
        "alter table archive set schema private;",
      ].join("\n"),
    }),
    [],
  );
});

test("only schemas the API exposes count, as configured in config.toml", () => {
  assert.deepEqual(
    findings({ [INIT]: "create table private.secrets (id int);" }),
    [],
  );
  const exposed = findings({
    "supabase/config.toml":
      '[api]\nenabled = true\nschemas = ["public", "api"]\n',
    [INIT]:
      "create table api.items (id int);\ncreate table private.keys (id int);",
  });
  assert.deepEqual(
    exposed.map(({ message }) => message.split(" is ")[0]),
    ["Table api.items"],
  );
});

test("a table whose privileges are revoked from anon and authenticated is not exposed", () => {
  assert.deepEqual(
    findings({
      [INIT]: `${TODOS}\nrevoke all on table public.todos from anon, authenticated;`,
    }),
    [],
  );
  assert.equal(
    findings({
      [INIT]: `${TODOS}\nrevoke all privileges on public.todos from anon;`,
    }).length,
    1,
  );
  // A later grant exposes it again.
  assert.equal(
    findings({
      [INIT]: `${TODOS}\nrevoke all on todos from anon, authenticated;`,
      [LATER]: "grant select on table todos to anon;",
    }).length,
    1,
  );
});

test("comments, strings, function bodies, and quoted names do not confuse the parser", () => {
  assert.deepEqual(
    findings({
      [INIT]: [
        "-- create table commented_out (id int);",
        "/* create table also_commented (id int); */",
        "insert into notes values ('create table fake; (id int)');",
        "create function public.make_temp() returns void language plpgsql as $$",
        "begin",
        "  create table if not exists scratch (id int);",
        "end;",
        "$$;",
        'create table "public"."Todos" (id int);',
        'alter table public."Todos" enable row level security;',
        "create temporary table session_cache (id int);",
      ].join("\n"),
    }),
    [],
  );
});

test("write policies open to every row are reported; read policies and scoped policies are not", () => {
  const result = findings({
    [INIT]: [
      TODOS,
      "alter table todos enable row level security;",
      'create policy "Anyone can update" on todos for update using (true);',
      'create policy "Public read" on todos for select using (true);',
      'create policy "Anon insert" on public.todos for insert to anon with check (true);',
      'create policy "Members insert" on todos for insert to authenticated with check (true);',
      'create policy "Own rows" on todos for all to authenticated using ((select auth.uid()) = user_id);',
      'create policy "Temporary" on todos for delete using (true);',
      'drop policy if exists "Temporary" on todos;',
      'create policy "Everything" on todos using ((true));',
    ].join("\n"),
  });
  assert.deepEqual(
    result.map(({ rule, severity, line, message }) => ({
      rule,
      severity,
      line,
      message,
    })),
    [
      {
        rule: "supabase-permissive-policy",
        severity: "warning",
        line: 7,
        message:
          'Policy "Anyone can update" on public.todos lets any user update every row: its using expression is true',
      },
      {
        rule: "supabase-permissive-policy",
        severity: "warning",
        line: 9,
        message:
          'Policy "Anon insert" on public.todos lets anonymous users insert any row: its with check expression is true',
      },
      {
        rule: "supabase-permissive-policy",
        severity: "warning",
        line: 14,
        message:
          'Policy "Everything" on public.todos lets any user update and delete every row: its using expression is true',
      },
    ],
  );
});

test("projects without Supabase migrations are not checked", () => {
  withProject({ "index.js": "console.log(1);" }, (directory) => {
    assert.deepEqual(supabaseRlsIssues(createScanContext(directory)), {
      migrations: 0,
      issues: [],
    });
  });
});

test("a SQL comment suppresses a finding with a reason", async () => {
  const directory = createProject({
    "package.json": '{"name":"rls"}',
    ".gitignore": ".env\n",
    [INIT]: [
      "-- codediag-ignore-next-line supabase-table-without-rls -- public reference data, writes revoked in the dashboard",
      "create table countries (code text primary key);",
      "create table orders (id int);",
    ].join("\n"),
  });
  try {
    const config = loadConfig(directory);
    const result = await scan(
      directory,
      {
        ...config,
        analyzers: {
          api: false,
          security: true,
          dependencies: false,
          testing: false,
          structure: false,
        },
      },
      { interactive: false, audit: false },
    );
    const rls = result.analyzers
      .flatMap((analyzer) => analyzer.issues)
      .filter((issue) => issue.rule === "supabase-table-without-rls");
    assert.deepEqual(
      rls.map(({ message, suppression }) => ({
        table: message.split(" ")[1],
        suppressed: suppression !== undefined,
      })),
      [
        { table: "public.countries", suppressed: true },
        { table: "public.orders", suppressed: false },
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
