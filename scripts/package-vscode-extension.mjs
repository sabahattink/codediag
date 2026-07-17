import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDirectory = resolve(root, "extensions/vscode");
const manifest = JSON.parse(
  await readFile(resolve(extensionDirectory, "package.json"), "utf8"),
);
const artifactsDirectory = resolve(root, "artifacts");
const output = resolve(
  artifactsDirectory,
  `codediag-vscode-${manifest.version}.vsix`,
);
const vsceEntry = resolve(root, "node_modules/@vscode/vsce/vsce");

await mkdir(artifactsDirectory, { recursive: true });

const result = spawnSync(
  process.execPath,
  [vsceEntry, "package", "--no-dependencies", "--out", output],
  { cwd: extensionDirectory, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
