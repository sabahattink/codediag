import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  afterSuppression,
  collectEditorDiagnostics,
  countSeverities,
  type EditorDiagnostic,
  isSuppressionRequest,
  quickFixes,
  ruleDocumentationUrl,
  type SuppressionEdit,
  type SuppressionRequest,
  suppressionEdit,
} from "../extensions/vscode/src/core.js";
import { loadConfig } from "../src/config.js";
import { isActive } from "../src/core/issues.js";
import { RULES, RULES_DOCUMENT_URL } from "../src/rules/registry.js";
import { scan } from "../src/scanner.js";
import type { CodediagConfig, ScanResult } from "../src/types.js";

// Directive text is assembled at runtime so this file holds no real directives.
const NEXT_LINE = ["codediag", "ignore-next-line"].join("-");
const FILE = ["codediag", "ignore-file"].join("-");
const PLACEHOLDER = "${1:reason}";
const SOURCE_FILE = join(resolve("workspace-fixture"), "src", "run.ts");
const SOURCE = [
  "export function run(plugin: string) {",
  "    eval(plugin);",
  "}",
].join("\n");

function fixture(): ScanResult {
  return {
    project: "workspace",
    stack: {
      framework: "express",
      language: "typescript",
      orm: null,
      hasDocker: false,
      hasEnvFile: false,
      hasPrisma: false,
      hasTests: true,
      packageManager: "npm",
    },
    analyzers: [
      {
        name: "Security",
        score: 60,
        summary: "Review required",
        issues: [
          {
            severity: "critical",
            rule: "hardcoded-secret",
            message: "Potential secret",
            file: "src/config.ts",
            line: 8,
            fix: "Use an environment variable",
          },
          {
            severity: "warning",
            rule: "outside-workspace",
            message: "Unsafe path fixture",
            file: "../outside.ts",
          },
          {
            severity: "info",
            rule: "fileless",
            message: "Project-level finding",
          },
        ],
      },
      {
        name: "Testing",
        score: 80,
        summary: "One finding",
        issues: [
          {
            severity: "warning",
            rule: "coverage",
            message: "Coverage is low",
            file: "coverage/summary.json",
          },
        ],
      },
    ],
    totalScore: 70,
    grade: "C",
    timestamp: "2026-07-17T00:00:00.000Z",
  };
}

test("editor diagnostics preserve findings inside the workspace", () => {
  const root = resolve("workspace-fixture");
  const summary = collectEditorDiagnostics(fixture(), root);

  assert.equal(summary.diagnostics.length, 2);
  assert.equal(summary.fileless, 1);
  assert.equal(summary.outsideWorkspace, 1);
  assert.deepEqual(summary.diagnostics[0], {
    analyzer: "Security",
    severity: "critical",
    rule: "hardcoded-secret",
    message: "Potential secret",
    filePath: join(root, "src", "config.ts"),
    line: 7,
    fix: "Use an environment variable",
  });
  assert.equal(summary.diagnostics[1]?.line, 0);
});

test("absolute paths outside the workspace are rejected", () => {
  const root = resolve("workspace-fixture");
  const result = fixture();
  const issue = result.analyzers[0]?.issues[0];
  assert.ok(issue);
  issue.file = resolve(root, "..", "outside.ts");

  const summary = collectEditorDiagnostics(result, root);
  assert.equal(summary.outsideWorkspace, 2);
  assert.equal(summary.diagnostics.length, 1);
});

test("severity counts include located and project-level findings", () => {
  assert.deepEqual(countSeverities(fixture()), {
    critical: 1,
    warning: 2,
    info: 1,
  });
});

test("editor diagnostics and counts skip suppressed and baseline findings", () => {
  const result = fixture();
  result.analyzers[0].issues[0].suppression = {
    kind: "inSource",
    justification: "test fixture",
  };
  result.analyzers[1].issues[0].baseline = true;

  const summary = collectEditorDiagnostics(
    result,
    resolve("workspace-fixture"),
  );

  assert.deepEqual(
    summary.diagnostics.map((diagnostic) => diagnostic.rule),
    [],
  );
  assert.deepEqual(countSeverities(result), {
    critical: 0,
    warning: 1,
    info: 1,
  });
});

function finding(overrides: Partial<EditorDiagnostic> = {}): EditorDiagnostic {
  return {
    analyzer: "Security",
    severity: "critical",
    rule: "unsafe-dynamic-code",
    message: "Dynamic code execution",
    filePath: SOURCE_FILE,
    line: 1,
    ...overrides,
  };
}

function request(
  overrides: Partial<SuppressionRequest> = {},
): SuppressionRequest {
  return {
    scope: "line",
    filePath: SOURCE_FILE,
    rule: "unsafe-dynamic-code",
    line: 1,
    fileLevel: false,
    ...overrides,
  };
}

/** The document after the user accepts the snippet and types a reason. */
function applyEdit(text: string, edit: SuppressionEdit, reason: string) {
  const lines = text.split("\n");
  lines.splice(
    edit.line,
    0,
    edit.snippet.replace(PLACEHOLDER, reason).replace(/\n$/, ""),
  );
  return lines.join("\n");
}

test("findings without a line are marked file-level", () => {
  const summary = collectEditorDiagnostics(
    fixture(),
    resolve("workspace-fixture"),
  );

  assert.equal(summary.diagnostics[0]?.fileLevel, undefined);
  assert.equal(summary.diagnostics[1]?.fileLevel, true);
});

test("rule documentation links resolve to the rule's heading", () => {
  const rulesDocument = readFileSync(
    new URL("../docs/rules.md", import.meta.url),
    "utf8",
  );

  assert.equal(
    ruleDocumentationUrl("hardcoded-secret"),
    `${RULES_DOCUMENT_URL}#hardcoded-secret`,
  );
  assert.equal(ruleDocumentationUrl("not-a-rule"), RULES_DOCUMENT_URL);
  // GitHub anchors are the lowercased, hyphenated heading text, so a
  // kebab-case heading's anchor is the rule ID itself.
  for (const id of Object.keys(RULES)) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(rulesDocument.includes(`\n### ${id}\n`), id);
  }
});

test("line suppressions go above the finding with its indentation", () => {
  assert.deepEqual(suppressionEdit(request(), SOURCE), {
    scope: "line",
    rule: "unsafe-dynamic-code",
    line: 1,
    snippet: `    // ${NEXT_LINE} unsafe-dynamic-code -- ${PLACEHOLDER}\n`,
  });
  assert.equal(
    suppressionEdit(request(), "function run() {\n\t\teval(code);\n}")?.snippet,
    `\t\t// ${NEXT_LINE} unsafe-dynamic-code -- ${PLACEHOLDER}\n`,
  );
});

test("file suppressions go after the shebang and leading comments", () => {
  const scoped = request({ scope: "file" });

  assert.deepEqual(suppressionEdit(scoped, SOURCE), {
    scope: "file",
    rule: "unsafe-dynamic-code",
    line: 0,
    snippet: `// ${FILE} unsafe-dynamic-code -- ${PLACEHOLDER}\n`,
  });
  const header = [
    "#!/usr/bin/env node",
    "/**",
    " * @jest-environment node",
    " */",
    "// @ts-check",
    "",
    '"use strict";',
    "eval(code);",
  ].join("\n");
  assert.equal(suppressionEdit({ ...scoped, line: 7 }, header)?.line, 6);
  assert.equal(
    suppressionEdit({ ...scoped, line: 0 }, "/* header */ eval(code);")?.line,
    0,
  );
});

test("suppressions are offered only where the scanner applies them", () => {
  const fileLevel = request({ line: 0, fileLevel: true });
  assert.equal(suppressionEdit(fileLevel, SOURCE), null);
  assert.equal(
    suppressionEdit({ ...fileLevel, scope: "file" }, SOURCE)?.line,
    0,
  );

  // The scanner reads directives from JavaScript and TypeScript only.
  for (const name of ["package.json", ".env", "Dockerfile", "ci.yml"]) {
    const filePath = join(resolve("workspace-fixture"), name);
    for (const scope of ["line", "file"] as const) {
      assert.equal(suppressionEdit(request({ filePath, scope }), SOURCE), null);
    }
  }

  assert.equal(suppressionEdit(request({ line: 3 }), SOURCE), null);
  // Findings about directives are reported after suppressions apply.
  for (const rule of ["unused-suppression", "suppression-missing-reason"]) {
    assert.equal(suppressionEdit(request({ rule, line: 0 }), SOURCE), null);
    assert.equal(
      suppressionEdit(request({ rule, line: 0, scope: "file" }), SOURCE),
      null,
    );
  }
});

test("findings already suppressed in the document get no suppression", () => {
  const suppressedLine = [
    "export function run(plugin: string) {",
    `    // ${NEXT_LINE} unsafe-dynamic-code -- trusted plugin`,
    "    eval(plugin);",
    "}",
  ].join("\n");
  const suppressedFile = `// ${FILE} unsafe-dynamic-code -- sandbox\n${SOURCE}`;
  const missingReason = suppressedLine.replace(" -- trusted plugin", "");

  for (const scope of ["line", "file"] as const) {
    assert.equal(
      suppressionEdit(request({ scope, line: 2 }), suppressedLine),
      null,
    );
    assert.equal(
      suppressionEdit(request({ scope, line: 2 }), suppressedFile),
      null,
    );
    // The scanner ignores a directive without a reason.
    assert.notEqual(
      suppressionEdit(request({ scope, line: 2 }), missingReason),
      null,
    );
  }
});

test("quick fixes list suppressions before the rule explanation", () => {
  assert.deepEqual(quickFixes(finding(), SOURCE), [
    {
      kind: "suppress",
      title: "Suppress unsafe-dynamic-code on this line",
      request: request(),
    },
    {
      kind: "suppress",
      title: "Suppress unsafe-dynamic-code in this file",
      request: request({ scope: "file" }),
    },
    {
      kind: "explain",
      title: "Explain unsafe-dynamic-code",
      url: `${RULES_DOCUMENT_URL}#unsafe-dynamic-code`,
    },
  ]);

  const manifest = finding({
    rule: "vuln-high",
    filePath: join(resolve("workspace-fixture"), "package.json"),
    line: 0,
    fileLevel: true,
  });
  assert.deepEqual(
    quickFixes(manifest, "{}").map((fix) => fix.title),
    ["Explain vuln-high"],
  );
});

test("an applied suppression removes its findings and shifts later lines", () => {
  const findings = [
    finding({ line: 1 }),
    finding({ line: 4 }),
    finding({ rule: "open-cors", line: 1 }),
    finding({ rule: "open-cors", line: 0 }),
    finding({ line: 0, fileLevel: true }),
  ];
  const lines = (items: EditorDiagnostic[]) =>
    items.map(({ rule, line }) => [rule, line]);

  const lineEdit = suppressionEdit(request(), SOURCE);
  assert.ok(lineEdit);
  assert.deepEqual(lines(afterSuppression(findings, lineEdit)), [
    ["unsafe-dynamic-code", 5],
    ["open-cors", 2],
    ["open-cors", 0],
    ["unsafe-dynamic-code", 0],
  ]);

  const fileEdit = suppressionEdit(request({ scope: "file" }), SOURCE);
  assert.ok(fileEdit);
  assert.deepEqual(lines(afterSuppression(findings, fileEdit)), [
    ["open-cors", 2],
    ["open-cors", 1],
  ]);
});

test("suppression command arguments are validated", () => {
  assert.equal(isSuppressionRequest(request()), true);
  assert.equal(isSuppressionRequest(request({ scope: "file" })), true);
  for (const value of [
    undefined,
    null,
    "unsafe-dynamic-code",
    {},
    { ...request(), scope: "block" },
    { ...request(), line: -1 },
    { ...request(), line: 1.5 },
    { ...request(), fileLevel: "no" },
    { ...request(), rule: 1 },
  ]) {
    assert.equal(isSuppressionRequest(value), false, JSON.stringify(value));
  }
});

async function withProject(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codediag-quick-fix-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function securityOnly(directory: string): CodediagConfig {
  const config = loadConfig(directory);
  config.analyzers = {
    api: false,
    security: true,
    dependencies: false,
    testing: false,
    structure: true,
  };
  return config;
}

test("quick-fix directives are applied by a real scan", async () => {
  const files = {
    "src/run.ts": SOURCE,
    "src/cli.ts": [
      "#!/usr/bin/env node",
      "// Copyright header",
      "eval(first);",
      "eval(second);",
    ].join("\n"),
  };
  await withProject(
    { "package.json": "{}", "README.md": "x", ...files },
    async (directory) => {
      const config = securityOnly(directory);
      const before = await scan(directory, config, { interactive: false });
      const located = collectEditorDiagnostics(before, directory).diagnostics;
      const reasons = {
        "src/run.ts": "trusted plugin",
        "src/cli.ts": "sandbox",
      };

      for (const [name, reason] of Object.entries(reasons)) {
        const target = located.find(
          (item) => item.filePath === join(directory, name),
        );
        assert.ok(target, name);
        const text = files[name as keyof typeof files];
        const edit = suppressionEdit(
          {
            scope: name === "src/run.ts" ? "line" : "file",
            filePath: target.filePath,
            rule: target.rule,
            line: target.line,
            fileLevel: target.fileLevel === true,
          },
          text,
        );
        assert.ok(edit, name);
        writeFileSync(join(directory, name), applyEdit(text, edit, reason));
      }

      const after = await scan(directory, config, { interactive: false });
      const sourceFindings = after.analyzers
        .flatMap((analyzer) => analyzer.issues)
        .filter((issue) => issue.file?.startsWith("src/"));
      assert.deepEqual(
        sourceFindings
          .map((issue) => [
            issue.file,
            issue.rule,
            isActive(issue),
            issue.suppression?.justification,
          ])
          .sort(),
        [
          ["src/cli.ts", "unsafe-dynamic-code", false, "sandbox"],
          ["src/cli.ts", "unsafe-dynamic-code", false, "sandbox"],
          ["src/run.ts", "unsafe-dynamic-code", false, "trusted plugin"],
        ],
      );
    },
  );
});
