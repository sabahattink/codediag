import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSecuritySinks } from "../src/analyzers/security-sinks.js";
import { createScanContext } from "../src/core/scan-context.js";

/** Each finding of the given rules as [rule, severity, trimmed source line]. */
async function findings(rules: string[], lines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-injection-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "handler.ts"), lines.join("\n"));
    const issues = await analyzeSecuritySinks(createScanContext(directory));
    return issues
      .filter((issue) => rules.includes(issue.rule))
      .map((issue) => [
        issue.rule,
        issue.severity,
        lines[(issue.line ?? 0) - 1].trim(),
      ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("spawn and execFile with a shell are dynamic command execution", async () => {
  assert.deepEqual(
    await findings(
      ["dynamic-command-execution"],
      [
        'import { spawn, execFile } from "node:child_process";',
        'const cp = require("child_process");',
        "export function run(req, branch: string) {",
        '  spawn("git", ["log", req.query.ref], { shell: true });',
        "  execFile(branch, [], { shell: true });",
        '  cp.spawnSync("ls " + req.params.dir, { shell: "/bin/bash" });',
        '  spawn("git", ["log", req.query.ref]);',
        '  spawn("npm", ["test"], { shell: true });',
        '  execFile("git", ["log", branch], { shell: false });',
        "}",
      ],
    ),
    [
      [
        "dynamic-command-execution",
        "critical",
        'spawn("git", ["log", req.query.ref], { shell: true });',
      ],
      [
        "dynamic-command-execution",
        "warning",
        "execFile(branch, [], { shell: true });",
      ],
      [
        "dynamic-command-execution",
        "critical",
        'cp.spawnSync("ls " + req.params.dir, { shell: "/bin/bash" });',
      ],
    ],
  );
});

test("templates compiled from request data are template injection", async () => {
  assert.deepEqual(
    await findings(
      ["server-side-template-injection"],
      [
        'import ejs from "ejs";',
        'import * as pug from "pug";',
        'import Handlebars from "handlebars";',
        'import nunjucks from "nunjucks";',
        'import _ from "lodash";',
        'import template from "lodash.template";',
        "export function preview(req, res) {",
        "  const { body } = req;",
        "  res.send(ejs.render(req.body.template, { user }));",
        "  pug.compile(req.query.layout)();",
        "  Handlebars.compile(body.source)(data);",
        "  nunjucks.renderString(req.body.tpl, data);",
        "  _.template(req.query.t)(data);",
        "  template(req.body.t)(data);",
        '  ejs.render("<p><%= name %></p>", { name: req.query.name });',
        "  Handlebars.compile(loadTemplate(req.params.id));",
        "}",
      ],
    ),
    [
      [
        "server-side-template-injection",
        "critical",
        "res.send(ejs.render(req.body.template, { user }));",
      ],
      [
        "server-side-template-injection",
        "critical",
        "pug.compile(req.query.layout)();",
      ],
      [
        "server-side-template-injection",
        "critical",
        "Handlebars.compile(body.source)(data);",
      ],
      [
        "server-side-template-injection",
        "critical",
        "nunjucks.renderString(req.body.tpl, data);",
      ],
      [
        "server-side-template-injection",
        "critical",
        "_.template(req.query.t)(data);",
      ],
      [
        "server-side-template-injection",
        "critical",
        "template(req.body.t)(data);",
      ],
    ],
  );
});

test("nested writes with request-controlled keys are prototype pollution", async () => {
  assert.deepEqual(
    await findings(
      ["prototype-pollution"],
      [
        "export function update(req) {",
        "  const { section, key, value } = req.body;",
        "  settings[section][key] = value;",
        "  settings[req.query.a][req.query.b][req.query.c] = 1;",
        "  settings[section] = value;",
        '  settings["ui"][key] = value;',
        "}",
        "export function guarded(req) {",
        "  const { section, key, value } = req.body;",
        '  if (section === "__proto__") throw new Error("bad key");',
        "  settings[section][key] = value;",
        "}",
      ],
    ),
    [
      ["prototype-pollution", "critical", "settings[section][key] = value;"],
      [
        "prototype-pollution",
        "critical",
        "settings[req.query.a][req.query.b][req.query.c] = 1;",
      ],
    ],
  );
});

test("recursive merges without a prototype key guard are prototype pollution", async () => {
  assert.deepEqual(
    await findings(
      ["prototype-pollution"],
      [
        "export function deepMerge(target, source) {",
        "  for (const key in source) {",
        "    if (typeof source[key] === 'object') deepMerge(target[key], source[key]);",
        "    else target[key] = source[key];",
        "  }",
        "  return target;",
        "}",
        "const assign = (target, source) => {",
        "  Object.keys(source).forEach((key) => {",
        "    target[key] = isObject(source[key]) ? assign(target[key] ?? {}, source[key]) : source[key];",
        "  });",
        "};",
        "export function safeMerge(target, source) {",
        "  for (const key of Object.keys(source)) {",
        '    if (key === "__proto__" || key === "constructor") continue;',
        "    target[key] = isObject(source[key]) ? safeMerge({}, source[key]) : source[key];",
        "  }",
        "}",
        "export function shallow(target, source) {",
        "  for (const key in source) target[key] = source[key];",
        "}",
      ],
    ),
    [
      [
        "prototype-pollution",
        "warning",
        "export function deepMerge(target, source) {",
      ],
      [
        "prototype-pollution",
        "warning",
        "const assign = (target, source) => {",
      ],
    ],
  );
});
