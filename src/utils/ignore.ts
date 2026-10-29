/**
 * Converts `.codediag.yml` ignore entries into glob ignore patterns
 * (gitignore-like semantics):
 * - an entry without a slash (`dist`, `*.log`) matches at any depth;
 * - an entry with a slash (`test/fixtures`, `./build`, `/out`) is anchored to the project root;
 * - every entry also matches everything below it when it names a directory.
 */
export function toGlobIgnore(entries: readonly string[]): string[] {
  const patterns = new Set<string>();
  for (const raw of entries) {
    const normalized = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const entry = normalized.replace(/^\.?\/+/, "");
    if (entry === "") continue;

    const anchored = normalized !== entry || entry.includes("/");
    const base = anchored ? entry : `**/${entry}`;
    patterns.add(base);
    if (!entry.endsWith("/**")) patterns.add(`${base}/**`);
  }
  return [...patterns];
}
