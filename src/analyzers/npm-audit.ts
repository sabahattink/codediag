import { spawnSync } from "child_process";

const AUDIT_TIMEOUT_MS = 30_000;

export interface AuditCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

export type AuditOutcome =
  | { ok: true; counts: AuditCounts }
  | { ok: false; reason: string };

/** Runs a dependency audit for a project. Injected so tests never hit the network. */
export type AuditRunner = (projectPath: string) => AuditOutcome;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parses `npm audit --json` stdout (npm >= 7 format, including its error payload). */
export function parseNpmAuditOutput(stdout: string): AuditOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "npm audit did not return JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "unexpected npm audit output" };

  if (isRecord(parsed.error)) {
    const summary = parsed.error.summary;
    const code = parsed.error.code;
    const reason = typeof summary === "string" && summary.trim() !== "" ? summary.split("\n")[0] ?? "" : String(code ?? "unknown error");
    return { ok: false, reason: reason.trim() };
  }

  const metadata = parsed.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.vulnerabilities)) {
    return { ok: false, reason: "npm audit output has no vulnerability summary" };
  }
  const v = metadata.vulnerabilities;
  return { ok: true, counts: { critical: count(v.critical), high: count(v.high), moderate: count(v.moderate), low: count(v.low) } };
}

/**
 * Runs `npm audit --json`. npm exits non-zero when vulnerabilities are found,
 * so stdout is parsed regardless of the exit status.
 */
export const runNpmAudit: AuditRunner = (projectPath) => {
  const res = spawnSync("npm audit --json", {
    cwd: projectPath,
    shell: true,
    encoding: "utf-8",
    timeout: AUDIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { ok: false, reason: timedOut ? `timed out after ${AUDIT_TIMEOUT_MS / 1000}s` : res.error.message };
  }
  return parseNpmAuditOutput(res.stdout ?? "");
};
