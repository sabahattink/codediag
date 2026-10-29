import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { detectStack } from "../src/detectors/stack-detector.js";
import type { AuditRunner } from "../src/analyzers/npm-audit.js";
import { DEFAULT_CONFIG, type AnalyzerContext } from "../src/types.js";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
export const NEST_FIXTURE = join(FIXTURES, "sample-nestjs");
export const EXPRESS_FIXTURE = join(FIXTURES, "sample-express");
export const NEXT_FIXTURE = join(FIXTURES, "sample-nextjs");
export const NODE_FIXTURE = join(FIXTURES, "sample-node");

/** Offline stand-in for `npm audit`: reports no vulnerabilities. */
export const cleanAudit: AuditRunner = () => ({ ok: true, counts: { critical: 0, high: 0, moderate: 0, low: 0 } });

export function contextFor(projectPath: string, extraIgnore: readonly string[] = []): AnalyzerContext {
  return { ignore: [...DEFAULT_CONFIG.ignore, ...extraIgnore], stack: detectStack(projectPath) };
}

const created: string[] = [];

/** Creates a temporary project from a map of relative path → content. */
export function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "codediag-test-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** Copies a fixture into a temporary directory (optionally adding/overriding files). */
export function copyFixture(fixture: string, extraFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "codediag-fixture-"));
  created.push(dir);
  cpSync(fixture, dir, { recursive: true });
  for (const [rel, content] of Object.entries(extraFiles)) writeFileSync(join(dir, rel), content);
  return dir;
}

/** Writes (or overwrites) a file inside a temporary project. */
export function writeProjectFile(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

export function cleanupTempProjects(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
