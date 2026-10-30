import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditAdvisory, ImporterAudit } from "./audit-advisories.js";

/**
 * Successful dependency audits kept on disk for an hour, so repeated scans
 * and editor sessions reuse them without the network. Entries live in the
 * project's node_modules/.cache, are keyed by the audit command and the
 * exact lock file and package.json contents, and are validated on read like
 * any other file the scan does not control.
 */

export const AUDIT_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_VERSION = 1;
const SEVERITIES = new Set(["critical", "high", "moderate", "low"]);

export interface AuditCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

export interface PersistedAudit {
  summary: AuditCounts;
  advisories: AuditAdvisory[];
  /** A pnpm workspace audit split by package. */
  importers?: Record<string, ImporterAudit>;
  /** When the audit ran, in milliseconds since the epoch. */
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** The cache file for an audit, or null when the project has no node_modules. */
export function auditCacheFile(
  lockDirectory: string,
  key: string,
): string | null {
  const modules = join(lockDirectory, "node_modules");
  if (!existsSync(modules)) return null;
  const name = createHash("sha256").update(key).digest("hex");
  return join(modules, ".cache", "codediag", "audit", `${name}.json`);
}

function readSummary(value: unknown): AuditCounts | null {
  if (!isRecord(value)) return null;
  const { critical, high, moderate, low } = value;
  return isCount(critical) && isCount(high) && isCount(moderate) && isCount(low)
    ? { critical, high, moderate, low }
    : null;
}

function readAdvisories(value: unknown): AuditAdvisory[] | null {
  if (!Array.isArray(value)) return null;
  const advisories: AuditAdvisory[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !SEVERITIES.has(String(entry.severity)) ||
      (entry.title !== undefined && typeof entry.title !== "string") ||
      (entry.url !== undefined && typeof entry.url !== "string")
    ) {
      return null;
    }
    advisories.push({
      name: entry.name,
      severity: entry.severity as AuditAdvisory["severity"],
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
    });
  }
  return advisories;
}

/** Each package's share of a pnpm audit; null when any entry is malformed. */
function readImporters(value: unknown): Record<string, ImporterAudit> | null {
  if (!isRecord(value)) return null;
  const importers: Record<string, ImporterAudit> = {};
  for (const [importer, share] of Object.entries(value)) {
    if (!isRecord(share)) return null;
    const summary = readSummary(share.summary);
    const advisories = readAdvisories(share.advisories);
    if (!summary || !advisories) return null;
    importers[importer] = { summary, advisories };
  }
  return importers;
}

/** A cached audit younger than an hour, or null when absent, stale, or malformed. */
export function readPersistedAudit(
  file: string,
  now = Date.now(),
): PersistedAudit | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== CACHE_VERSION ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const createdAt = Date.parse(value.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    now - createdAt >= AUDIT_CACHE_TTL_MS
  ) {
    return null;
  }
  const summary = readSummary(value.summary);
  const advisories = readAdvisories(value.advisories);
  const importers =
    value.importers === undefined ? undefined : readImporters(value.importers);
  if (!summary || !advisories || importers === null) return null;
  return {
    summary,
    advisories,
    createdAt,
    ...(importers ? { importers } : {}),
  };
}

/**
 * Records a successful audit. A cache that cannot be written, such as a
 * read-only node_modules, only means the next scan audits again.
 */
export function persistAudit(
  file: string,
  audit: Omit<PersistedAudit, "createdAt">,
  now = Date.now(),
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        version: CACHE_VERSION,
        createdAt: new Date(now).toISOString(),
        summary: audit.summary,
        advisories: audit.advisories,
        ...(audit.importers ? { importers: audit.importers } : {}),
      })}\n`,
      "utf-8",
    );
  } catch {
    // Best effort by design; see above.
  }
}

/** How long ago a cached audit ran, for the analyzer summary. */
export function auditAge(createdAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - createdAt) / 60_000);
  if (minutes < 1) return "less than a minute ago";
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}
