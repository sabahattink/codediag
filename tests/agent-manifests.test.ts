import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { RULES, type RuleDefinition } from "../src/rules/registry.js";

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pkg = json("package.json") as {
  name: string;
  version: string;
  mcpName: string;
};
const plugin = json(".claude-plugin/plugin.json") as {
  name: string;
  version: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
};
const marketplace = json(".claude-plugin/marketplace.json") as {
  name: string;
  plugins: { name: string; source: string }[];
};
const server = json("server.json") as {
  name: string;
  version: string;
  packages: {
    identifier: string;
    version: string;
    packageArguments: { type: string; value: string }[];
  }[];
};

test("the plugin, marketplace, and MCP registry entry match the npm package", () => {
  assert.equal(plugin.name, "codediag");
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(plugin.mcpServers.codediag, {
    command: "npx",
    // @latest: inside a project that has (or is) the package, a bare name runs
    // that local copy, which may predate the mcp command.
    args: ["-y", `${pkg.name}@latest`, "mcp"],
  });

  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: plugin.name, source: "./" }],
  );

  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0]?.identifier, pkg.name);
  assert.equal(server.packages[0]?.version, pkg.version);
  assert.deepEqual(server.packages[0]?.packageArguments, [
    { type: "positional", value: "mcp" },
  ]);
});

const skill = readFileSync("skills/codediag/SKILL.md", "utf8");

test("the skill's frontmatter follows the Agent Skills specification", () => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n/g, "\n"));
  assert.ok(match, "SKILL.md starts with YAML frontmatter");
  const frontmatter = parse(match[1] ?? "") as Record<string, unknown>;
  assert.deepEqual(Object.keys(frontmatter).sort(), [
    "compatibility",
    "description",
    "license",
    "name",
  ]);
  assert.equal(frontmatter.name, "codediag");
  assert.match(String(frontmatter.name), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const description = String(frontmatter.description);
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.ok(String(frontmatter.compatibility).length <= 500);
});

test("the skill lists every auth and validation rule the MCP tool reports", () => {
  const rulesFor = (cwe: string) =>
    Object.entries(RULES as Record<string, RuleDefinition>)
      .filter(
        ([, rule]) =>
          rule.analyzer === "API Health" && rule.cwe?.includes(cwe) === true,
      )
      .map(([id]) => id)
      .sort();
  const listed = (label: string) => {
    const line = skill
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`- **${label}:**`));
    assert.ok(line, `SKILL.md has a "${label}" line`);
    return [...line.matchAll(/`([a-z0-9-]+)`/g)].map(([, id]) => id).sort();
  };
  assert.deepEqual(listed("No auth check"), rulesFor("CWE-306"));
  assert.deepEqual(listed("No input validation"), rulesFor("CWE-20"));
});
