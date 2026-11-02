import { posix } from "node:path";
import type { ScanContext } from "../core/scan-context.js";
import { fromRule } from "../rules/registry.js";
import type { DiagnosticIssue } from "../types.js";
import {
  IDENTIFIER,
  identifierValue,
  lineAt,
  parenthesized,
  QUALIFIED_NAME,
  qualifiedName,
  sqlStatements,
} from "./sql-statements.js";

/**
 * Row level security in Supabase migrations. The browser holds the anon key
 * and queries the Data API directly, so a table in an exposed schema without
 * RLS is readable and writable by anyone, however well the API routes are
 * guarded. Migrations are replayed in file order; the live database is never
 * read.
 */

const MIGRATIONS = "**/supabase/migrations/*.sql";
/** The schemas a new project's API exposes: `[api] schemas` in config.toml. */
const DEFAULT_EXPOSED_SCHEMAS = ["public", "graphql_public"];
const DEFAULT_SCHEMA = "public";
/** The roles behind the anon key and signed-in users. */
const API_ROLES = ["anon", "authenticated"];
/** Roles that bypass RLS or never come from a client. */
const SERVER_ROLES = new Set(["service_role", "postgres", "supabase_admin"]);

interface Table {
  schema: string;
  name: string;
  file: string;
  line: number;
  rls: boolean;
  revoked: Set<string>;
}

interface Policy {
  name: string;
  table: string;
  command: string;
  roles: string[];
  using: string | null;
  check: string | null;
  file: string;
  line: number;
}

interface State {
  tables: Map<string, Table>;
  policies: Map<string, Policy>;
}

interface Location {
  file: string;
  line: number;
}

const CREATE_TABLE = new RegExp(
  String.raw`^create (?:(?:global|local) )?(temp |temporary )?(?:unlogged )?table (?:if not exists )?(${QUALIFIED_NAME})(.*)$`,
  "i",
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter table (?:if exists )?(?:only )?(${QUALIFIED_NAME})\s*(.*)$`,
  "i",
);
const RENAME_TABLE = new RegExp(String.raw`^rename to (${IDENTIFIER})`, "i");
const SET_SCHEMA = new RegExp(String.raw`^set schema (${IDENTIFIER})`, "i");
const DROP_TABLE = /^drop table (?:if exists )?(.+?)(?: cascade| restrict)?$/i;
const PRIVILEGES =
  /^(grant|revoke) (?:grant option for )?(.+?) on (?:table )?(.+?) (?:to|from) (.+?)(?: with grant option| cascade| restrict| granted by .+)?$/i;
const ALL_TABLES_IN_SCHEMA = /^all tables in schema (.+)$/i;
const CREATE_POLICY = new RegExp(
  String.raw`^create policy (${IDENTIFIER}) on (${QUALIFIED_NAME})(.*)$`,
  "i",
);
const DROP_POLICY = new RegExp(
  String.raw`^drop policy (?:if exists )?(${IDENTIFIER}) on (${QUALIFIED_NAME})`,
  "i",
);

function tableKey(schema: string | null, name: string): string {
  return `${schema ?? DEFAULT_SCHEMA}.${name}`;
}

function keyOf(text: string): string {
  const { schema, name } = qualifiedName(text);
  return tableKey(schema, name);
}

function list(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isTrue(expression: string | null): boolean {
  if (expression === null) return false;
  let text = expression.trim();
  while (text.startsWith("(") && parenthesized(text, 0) === text.slice(1, -1)) {
    text = text.slice(1, -1).trim();
  }
  return text.toLowerCase() === "true";
}

function clause(rest: string, keyword: RegExp): string | null {
  const match = keyword.exec(rest);
  if (!match) return null;
  return parenthesized(rest, match.index + match[0].length - 1);
}

function createTable(state: State, text: string, at: Location): boolean {
  const match = CREATE_TABLE.exec(text);
  if (!match) return false;
  const [, temporary, name = "", rest = ""] = match;
  if (temporary || /^\s*partition of\b/i.test(rest)) return true;
  const { schema, name: table } = qualifiedName(name);
  state.tables.set(tableKey(schema, table), {
    schema: schema ?? DEFAULT_SCHEMA,
    name: table,
    ...at,
    rls: false,
    revoked: new Set(),
  });
  return true;
}

function alterTable(state: State, text: string): boolean {
  const match = ALTER_TABLE.exec(text);
  if (!match) return false;
  const [, name = "", actions = ""] = match;
  const key = keyOf(name);
  const table = state.tables.get(key);
  if (!table) return true;
  const rename = RENAME_TABLE.exec(actions);
  const move = SET_SCHEMA.exec(actions);
  if (rename || move) {
    state.tables.delete(key);
    if (rename) table.name = identifierValue(rename[1] ?? "");
    if (move) table.schema = identifierValue(move[1] ?? "");
    state.tables.set(tableKey(table.schema, table.name), table);
  }
  if (/\benable row level security\b/i.test(actions)) table.rls = true;
  if (/\bdisable row level security\b/i.test(actions)) table.rls = false;
  return true;
}

function dropTable(state: State, text: string): boolean {
  const match = DROP_TABLE.exec(text);
  if (!match) return false;
  for (const name of list(match[1] ?? "")) state.tables.delete(keyOf(name));
  return true;
}

/** `grant` and `revoke` change which API roles can reach a table at all. */
function privileges(state: State, text: string): boolean {
  const match = PRIVILEGES.exec(text);
  if (!match) return false;
  const [, verb = "", privilege = "", target = "", roleText = ""] = match;
  const roles = list(roleText).map((role) => role.toLowerCase());
  const schemas = ALL_TABLES_IN_SCHEMA.exec(target);
  const tables = schemas
    ? [...state.tables.values()].filter((table) =>
        list(schemas[1] ?? "")
          .map(identifierValue)
          .includes(table.schema),
      )
    : list(target).flatMap((name) => state.tables.get(keyOf(name)) ?? []);
  const revokesAll = /^all(?: privileges)?$/i.test(privilege.trim());
  for (const table of tables) {
    for (const role of roles) {
      if (verb.toLowerCase() === "grant") table.revoked.delete(role);
      else if (revokesAll) table.revoked.add(role);
    }
  }
  return true;
}

function createPolicy(state: State, text: string, at: Location): boolean {
  const match = CREATE_POLICY.exec(text);
  if (!match) return false;
  const [, name = "", table = "", rest = ""] = match;
  const roles = /\bto (.+?)(?= using\b| with check\b|$)/i.exec(rest)?.[1];
  const policy: Policy = {
    name: identifierValue(name),
    table: keyOf(table),
    command: (
      /\bfor (all|select|insert|update|delete)\b/i.exec(rest)?.[1] ?? "all"
    ).toLowerCase(),
    roles: roles
      ? list(roles).map((role) => identifierValue(role))
      : ["public"],
    using: clause(rest, /\busing\s*\(/i),
    check: clause(rest, /\bwith check\s*\(/i),
    ...at,
  };
  state.policies.set(`${policy.table}|${policy.name}`, policy);
  return true;
}

function dropPolicy(state: State, text: string): boolean {
  const match = DROP_POLICY.exec(text);
  if (!match) return false;
  const [, name = "", table = ""] = match;
  state.policies.delete(`${keyOf(table)}|${identifierValue(name)}`);
  return true;
}

function apply(state: State, text: string, at: Location): void {
  if (createTable(state, text, at)) return;
  if (alterTable(state, text)) return;
  if (dropTable(state, text)) return;
  if (privileges(state, text)) return;
  if (createPolicy(state, text, at)) return;
  dropPolicy(state, text);
}

function exposedSchemas(context: ScanContext, supabaseDir: string): string[] {
  const config = context.readText(posix.join(supabaseDir, "config.toml"));
  const api = config
    ? /^\[api\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)
    : null;
  const schemas = api
    ? /^\s*schemas\s*=\s*\[([^\]]*)\]/m.exec(api[1] ?? "")
    : null;
  if (!schemas) return DEFAULT_EXPOSED_SCHEMAS;
  return [...(schemas[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (value) => value[1] ?? value[2] ?? "",
  );
}

function tableIssue(table: Table): DiagnosticIssue {
  const display = `${table.schema}.${table.name}`;
  return {
    ...fromRule("supabase-table-without-rls"),
    message: `Table ${display} is exposed through the Supabase API without row level security, so anyone with the anon key can read and write it`,
    file: table.file,
    line: table.line,
    fix: `Run alter table ${display} enable row level security; and add a policy for each access you intend`,
  };
}

/** Who a policy applies to, in words. */
function audience(roles: string[]): string {
  const clients = roles.filter((role) => !SERVER_ROLES.has(role));
  if (clients.includes("public")) return "any user";
  if (clients.includes("anon")) {
    return clients.includes("authenticated") ? "any user" : "anonymous users";
  }
  return "any signed-in user";
}

function policyIssue(policy: Policy): DiagnosticIssue | null {
  const clients = policy.roles.filter((role) => !SERVER_ROLES.has(role));
  if (clients.length === 0) return null;
  const base = {
    ...fromRule("supabase-permissive-policy"),
    file: policy.file,
    line: policy.line,
    fix: "Limit the policy to the rows a user owns, for example using ((select auth.uid()) = user_id), or drop it if no client should write",
  };
  const writes =
    policy.command === "all"
      ? ["update", "delete"]
      : ["update", "delete"].includes(policy.command)
        ? [policy.command]
        : [];
  if (writes.length > 0 && isTrue(policy.using)) {
    return {
      ...base,
      message: `Policy "${policy.name}" on ${policy.table} lets ${audience(clients)} ${writes.join(" and ")} every row: its using expression is true`,
    };
  }
  const anonymous = clients.some(
    (role) => role === "public" || role === "anon",
  );
  const insertCheck =
    policy.command === "insert"
      ? policy.check
      : policy.command === "all"
        ? (policy.check ?? policy.using)
        : null;
  if (anonymous && isTrue(insertCheck)) {
    return {
      ...base,
      message: `Policy "${policy.name}" on ${policy.table} lets anonymous users insert any row: its with check expression is true`,
    };
  }
  return null;
}

export interface SupabaseRlsResult {
  /** Migration files read; 0 means the project has no Supabase migrations. */
  migrations: number;
  issues: DiagnosticIssue[];
}

export function supabaseRlsIssues(context: ScanContext): SupabaseRlsResult {
  const files = context.matchFiles(MIGRATIONS).sort();
  const projects = new Map<string, string[]>();
  for (const file of files) {
    const supabaseDir = posix.dirname(posix.dirname(file));
    projects.set(supabaseDir, [...(projects.get(supabaseDir) ?? []), file]);
  }

  const issues: DiagnosticIssue[] = [];
  for (const [supabaseDir, migrations] of projects) {
    const state: State = { tables: new Map(), policies: new Map() };
    for (const file of migrations) {
      const source = context.readText(file);
      if (source === null) continue;
      for (const { text, offset } of sqlStatements(source)) {
        apply(state, text, { file, line: lineAt(source, offset) });
      }
    }

    const exposed = exposedSchemas(context, supabaseDir);
    for (const table of state.tables.values()) {
      if (!exposed.includes(table.schema) || table.rls) continue;
      if (API_ROLES.every((role) => table.revoked.has(role))) continue;
      issues.push(tableIssue(table));
    }
    for (const policy of state.policies.values()) {
      const table = state.tables.get(policy.table);
      const schema = policy.table.slice(0, policy.table.indexOf("."));
      // Without RLS the table is already reported, and its policies do nothing.
      if (!exposed.includes(schema) || (table && !table.rls)) continue;
      const issue = policyIssue(policy);
      if (issue) issues.push(issue);
    }
  }
  return { migrations: files.length, issues };
}
