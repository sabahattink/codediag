/** One vulnerable package from a package manager audit. */
export interface AuditAdvisory {
  name: string;
  severity: "critical" | "high" | "moderate" | "low";
  title?: string;
  url?: string;
}

/** Packages listed per severity in a finding's fix text. */
const MAX_LISTED = 5;
const SEVERITIES = new Set(["critical", "high", "moderate", "low"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function advisory(
  name: unknown,
  severity: unknown,
  title?: unknown,
  url?: unknown,
): AuditAdvisory | null {
  const packageName = text(name);
  const level = typeof severity === "string" ? severity.toLowerCase() : "";
  if (!packageName || !SEVERITIES.has(level)) return null;
  const titleText = text(title);
  const urlText = text(url);
  return {
    name: packageName,
    severity: level as AuditAdvisory["severity"],
    ...(titleText ? { title: titleText } : {}),
    ...(urlText ? { url: urlText } : {}),
  };
}

/** npm 7+: `vulnerabilities` keyed by package, with advisories in `via`. */
function npmAdvisories(document: Record<string, unknown>): AuditAdvisory[] {
  if (!isRecord(document.vulnerabilities)) return [];
  return Object.entries(document.vulnerabilities).flatMap(([name, entry]) => {
    if (!isRecord(entry)) return [];
    const source = Array.isArray(entry.via)
      ? entry.via.find(isRecord)
      : undefined;
    const found = advisory(name, entry.severity, source?.title, source?.url);
    return found ? [found] : [];
  });
}

/** pnpm and npm 6: `advisories` keyed by advisory ID. */
function advisoryMap(document: Record<string, unknown>): AuditAdvisory[] {
  if (!isRecord(document.advisories)) return [];
  return Object.values(document.advisories).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const found = advisory(
      entry.module_name,
      entry.severity,
      entry.title,
      entry.url,
    );
    return found ? [found] : [];
  });
}

/** Yarn Classic `auditAdvisory` lines and Yarn Berry `{ value, children }` lines. */
function yarnAdvisory(line: Record<string, unknown>): AuditAdvisory | null {
  if (line.type === "auditAdvisory" && isRecord(line.data)) {
    const data = isRecord(line.data.advisory) ? line.data.advisory : undefined;
    return data
      ? advisory(data.module_name, data.severity, data.title, data.url)
      : null;
  }
  if (isRecord(line.children)) {
    const { children } = line;
    return advisory(
      line.value,
      children.Severity,
      children.Issue,
      children.URL,
    );
  }
  return null;
}

/**
 * The vulnerable packages an audit reports, one entry per package and
 * severity, most severe first. Unknown formats yield an empty list; the
 * severity counts are parsed separately and stay authoritative.
 */
export function parseAuditAdvisories(output: string): AuditAdvisory[] {
  const found: AuditAdvisory[] = [];
  const trimmed = output.trim();
  try {
    const document: unknown = JSON.parse(trimmed);
    if (isRecord(document)) {
      found.push(...npmAdvisories(document), ...advisoryMap(document));
    }
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        const entry: unknown = JSON.parse(line);
        const parsed = isRecord(entry) ? yarnAdvisory(entry) : null;
        if (parsed) found.push(parsed);
      } catch {
        // Progress lines between JSON entries are ignored.
      }
    }
  }

  return uniqueAdvisories(found);
}

/** One entry per package and severity, most severe first. */
function uniqueAdvisories(found: AuditAdvisory[]): AuditAdvisory[] {
  const order = ["critical", "high", "moderate", "low"];
  const unique = new Map<string, AuditAdvisory>();
  for (const entry of found) {
    const key = `${entry.severity}\u0000${entry.name}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort(
    (left, right) =>
      order.indexOf(left.severity) - order.indexOf(right.severity) ||
      left.name.localeCompare(right.name),
  );
}

/** One workspace package's share of a pnpm audit. */
export interface ImporterAudit {
  summary: Record<AuditAdvisory["severity"], number>;
  advisories: AuditAdvisory[];
}

/** The importers a pnpm finding's paths start from: "packages__api>lodash". */
function importersOf(findings: unknown): Set<string> {
  const importers = new Set<string>();
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!isRecord(finding) || !Array.isArray(finding.paths)) continue;
    for (const path of finding.paths) {
      const end = typeof path === "string" ? path.indexOf(">") : -1;
      if (end > 0) importers.add(path.slice(0, end));
    }
  }
  return importers;
}

/**
 * Splits a pnpm audit by importer. pnpm audits the whole workspace lock
 * file from any package, and each finding's paths start with the importer
 * that reaches it (`packages__api` for packages/api, `.` for the root);
 * counts follow pnpm's own, one per advisory. Null when the output is not a
 * pnpm audit or an advisory has no path to attribute it by.
 */
export function pnpmImporters(
  output: string,
): Record<string, ImporterAudit> | null {
  let document: unknown;
  try {
    document = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!isRecord(document) || !isRecord(document.advisories)) return null;
  const importers = new Map<string, ImporterAudit>();
  for (const entry of Object.values(document.advisories)) {
    if (!isRecord(entry)) return null;
    const found = advisory(
      entry.module_name,
      entry.severity,
      entry.title,
      entry.url,
    );
    const owners = importersOf(entry.findings);
    if (!found || owners.size === 0) return null;
    for (const owner of owners) {
      const share = importers.get(owner) ?? {
        summary: { critical: 0, high: 0, moderate: 0, low: 0 },
        advisories: [],
      };
      importers.set(owner, {
        summary: {
          ...share.summary,
          [found.severity]: share.summary[found.severity] + 1,
        },
        advisories: [...share.advisories, found],
      });
    }
  }
  return Object.fromEntries(
    [...importers].map(([owner, share]) => [
      owner,
      { ...share, advisories: uniqueAdvisories(share.advisories) },
    ]),
  );
}

/** "Affected: lodash (Prototype Pollution, https://…), qs, and 3 more." */
export function describeAdvisories(
  advisories: AuditAdvisory[],
  severity: AuditAdvisory["severity"],
): string {
  const matching = advisories.filter((entry) => entry.severity === severity);
  if (matching.length === 0) return "";
  const listed = matching.slice(0, MAX_LISTED).map((entry) => {
    const details = [entry.title, entry.url].filter(Boolean).join(", ");
    return details ? `${entry.name} (${details})` : entry.name;
  });
  const more = matching.length - listed.length;
  return ` Affected: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}
