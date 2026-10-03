import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderRulesMarkdown } from "../src/rules/docs.js";
import { getRule, RULES } from "../src/rules/registry.js";

const sourceDirectory = join(import.meta.dirname, "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );
}

function emittedRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of sourceFiles(join(sourceDirectory, "analyzers"))) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/fromRule\(\s*"([^"]+)"\s*\)/g)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

test("every emitted rule is registered and every registered rule is emitted", () => {
  const emitted = emittedRuleIds();
  const registered = new Set(Object.keys(RULES));

  assert.deepEqual(
    [...emitted].filter((id) => !registered.has(id)),
    [],
    "emitted but not registered",
  );
  assert.deepEqual(
    [...registered].filter((id) => !emitted.has(id)),
    [],
    "registered but never emitted",
  );
});

test("analyzers emit findings through the registry, not raw rule strings", () => {
  for (const file of sourceFiles(join(sourceDirectory, "analyzers"))) {
    assert.doesNotMatch(
      readFileSync(file, "utf-8"),
      /\brule:\s*["'`]/,
      `${file} sets a rule id without fromRule()`,
    );
  }
});

test("registry entries are complete and root causes reference real rules", () => {
  for (const [id, rule] of Object.entries(RULES)) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, id);
    assert.ok(rule.title.length > 0, `${id} title`);
    assert.match(rule.description, /\.$/, `${id} description`);
    for (const cwe of "cwe" in rule ? rule.cwe : []) {
      assert.match(cwe, /^CWE-\d+$/, `${id} ${cwe}`);
    }
    if ("rootCause" in rule) {
      assert.ok(getRule(rule.rootCause), `${id} root cause ${rule.rootCause}`);
      assert.notEqual(rule.rootCause, id);
    }
  }
  assert.equal(getRule("toString"), undefined);
});

test("docs/rules.md matches the registry (run npm run docs:rules)", () => {
  const committed = readFileSync(
    join(import.meta.dirname, "..", "docs", "rules.md"),
    "utf-8",
  );
  assert.equal(committed, renderRulesMarkdown());
});
