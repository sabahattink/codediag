import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeSecurity } from "../src/analyzers/security.js";
import { createScanContext } from "../src/core/scan-context.js";

const SECRET_RULES = new Set(["hardcoded-secret", "committed-env-secret"]);

// Assembled at runtime so this file does not itself contain token patterns.
const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");
const GITHUB_TOKEN = [
  "ghp_",
  "x".repeat(4),
  "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6",
].join("");
const NPM_TOKEN = ["npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const STRONG_PASSWORD = ["V9xkq2", "LmX7pR", "zT4wQe"].join("");

interface Options {
  git?: string[];
}

async function secretFindings(
  files: Record<string, string>,
  options: Options = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-secrets-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    if (options.git) {
      execFileSync("git", ["init", "-q"], { cwd: directory });
      execFileSync("git", ["add", "-f", ...options.git], { cwd: directory });
    }
    const result = await analyzeSecurity(createScanContext(directory));
    return result.issues
      .filter((issue) => SECRET_RULES.has(issue.rule))
      .map(({ rule, file, line, message }) => ({ rule, file, line, message }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("provider tokens and secret keys in configuration files are reported", async () => {
  const findings = await secretFindings({
    ".gitignore": ".env\n",
    "config/production.json": JSON.stringify(
      { aws: { accessKeyId: AWS_KEY }, db: { password: STRONG_PASSWORD } },
      null,
      2,
    ),
    "docker-compose.yml": [
      "services:",
      "  api:",
      "    environment:",
      `      - GITHUB_TOKEN=${GITHUB_TOKEN}`,
      "      - POSTGRES_PASSWORD=postgres",
      "      - API_KEY=${API_KEY}",
    ].join("\n"),
    Dockerfile: [
      "FROM node:22",
      `ENV CLIENT_SECRET=${STRONG_PASSWORD}`,
      "ARG NPM_TOKEN",
    ].join("\n"),
  });

  assert.deepEqual(findings, [
    {
      rule: "hardcoded-secret",
      file: "Dockerfile",
      line: 2,
      message:
        "Possible secret value for CLIENT_SECRET in a configuration file",
    },
    {
      rule: "hardcoded-secret",
      file: "config/production.json",
      line: 3,
      message: "Possible AWS access key in a configuration file",
    },
    {
      rule: "hardcoded-secret",
      file: "config/production.json",
      line: 6,
      message: "Possible secret value for password in a configuration file",
    },
    {
      rule: "hardcoded-secret",
      file: "docker-compose.yml",
      line: 4,
      message: "Possible GitHub token in a configuration file",
    },
  ]);
});

test("findings never contain the secret value", async () => {
  const findings = await secretFindings({
    ".gitignore": ".env\n",
    "settings.yaml": `apiKey: ${STRONG_PASSWORD}\n`,
  });
  assert.equal(findings.length, 1);
  assert.ok(!JSON.stringify(findings).includes(STRONG_PASSWORD));
});

test("placeholders, references, lock files, and low-entropy values are ignored", async () => {
  assert.deepEqual(
    await secretFindings({
      ".gitignore": ".env\n",
      "config/default.json": JSON.stringify(
        {
          // codediag-ignore-next-line hardcoded-secret -- placeholder the config scanner must ignore
          password: "changeme",
          token: "${TOKEN}",
          secret: "<your-secret-here>",
          apiKey: "{{ api_key }}",
          tokenUrl: "https://example.com/oauth/token",
          clientSecret: "your-client-secret",
        },
        null,
        2,
      ),
      "app.yml":
        "db:\n  password: postgres\n  passwordPolicy: strict-mode-on\n",
      "package-lock.json": JSON.stringify({ integrity: STRONG_PASSWORD }),
    }),
    [],
  );
});

test("a committed .npmrc auth token is reported, an environment reference is not", async () => {
  assert.deepEqual(
    await secretFindings({
      ".gitignore": ".env\n",
      ".npmrc": `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
      "packages/web/.npmrc": "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    }),
    [
      {
        rule: "hardcoded-secret",
        file: ".npmrc",
        line: 1,
        message: "Possible npm token in a configuration file",
      },
    ],
  );
});

test("secrets in .env files tracked by Git are reported; ignored ones are not", async () => {
  assert.deepEqual(
    await secretFindings(
      {
        ".gitignore": ".env.local\n",
        ".env": `PORT=3000\nNEXT_PUBLIC_SITE=https://example.com\nSTRIPE_SECRET_KEY=${["sk", "live", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("_")}\n`,
        ".env.production": `SESSION_SECRET=${STRONG_PASSWORD}\n`,
        ".env.local": `DATABASE_PASSWORD=${STRONG_PASSWORD}\n`,
        ".env.example": "SESSION_SECRET=replace-me\n",
      },
      { git: [".env", ".env.production", ".env.example", ".gitignore"] },
    ),
    [
      {
        rule: "committed-env-secret",
        file: ".env",
        line: 3,
        message: "Committed .env file contains a Stripe key",
      },
      {
        rule: "committed-env-secret",
        file: ".env.production",
        line: 1,
        message:
          "Committed .env file contains a secret value for SESSION_SECRET",
      },
    ],
  );
});

test("tracked .env files in ignored or dependency directories are not scanned", async () => {
  assert.deepEqual(
    await secretFindings(
      {
        ".gitignore": ".env*\n",
        ".codediag.yml": "ignore:\n  - fixtures/**\n",
        "fixtures/app/.env": `SESSION_SECRET=${STRONG_PASSWORD}\n`,
        "node_modules/lib/.env": `SESSION_SECRET=${STRONG_PASSWORD}\n`,
      },
      { git: ["fixtures/app/.env", "node_modules/lib/.env"] },
    ),
    [],
  );
});
