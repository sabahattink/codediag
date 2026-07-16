import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { isBelowThreshold, loadConfig, parseThreshold } from "./config.js";
import { renderJson } from "./reporters/json.js";
import { renderSvg } from "./reporters/svg.js";
import { renderTerminal } from "./reporters/terminal.js";
import { scan } from "./scanner.js";
import type { ScanResult } from "./types.js";
import { getPackageVersion } from "./version.js";

const OUTPUT_FORMATS = new Set(["terminal", "json", "md", "svg"]);

function renderMarkdown(result: ScanResult): string {
  const lines = [
    `## codediag \u2014 Diagnostic Report`,
    ``,
    `| Metric | Score |`,
    `|--------|-------|`,
  ];

  for (const a of result.analyzers) {
    const icon =
      a.score >= 80 ? "\u2705" : a.score >= 60 ? "\u26A0\uFE0F" : "\u274C";
    lines.push(`| ${icon} ${a.name} | ${a.score}/100 |`);
  }

  lines.push(`| **Total** | **${result.totalScore}/100 (${result.grade})** |`);
  lines.push(``);
  lines.push(
    `> Scanned by [codediag](https://github.com/sabahattink/codediag) on ${new Date().toLocaleDateString()}`,
  );

  return lines.join("\n");
}

const program = new Command();

program
  .name("codediag")
  .description(
    chalk.bold("codediag") +
      " \u2014 Diagnose your code before you ship.\n\n" +
      "  Automated project health scanner for NestJS and beyond.\n" +
      "  https://github.com/sabahattink/codediag",
  )
  .version(getPackageVersion(), "-v, --version");

program
  .command("scan")
  .description("Scan a project and generate a diagnostic report")
  .argument("[path]", "Project directory to scan", ".")
  .option(
    "-f, --format <type>",
    "Output format: terminal, json, md, svg",
    "terminal",
  )
  .option("-t, --threshold <number>", "Minimum passing score")
  .option("--ci", "CI mode: JSON output + exit code")
  .option("--quiet", "Show score only")
  .option("--verbose", "Show all issues including info")
  .action(async (path: string, options) => {
    const targetPath = resolve(path);
    const format = options.ci ? "json" : options.format;

    try {
      if (!OUTPUT_FORMATS.has(format)) {
        throw new Error(
          `Unknown output format "${format}". Expected terminal, json, md, or svg.`,
        );
      }

      const hasConfig = existsSync(resolve(targetPath, ".codediag.yml"));
      const config = loadConfig(targetPath);
      const threshold =
        options.threshold !== undefined
          ? parseThreshold(options.threshold)
          : options.ci || hasConfig
            ? config.threshold
            : null;
      const result = await scan(targetPath, config);

      switch (format) {
        case "json":
          renderJson(result);
          break;
        case "md":
          console.log(renderMarkdown(result));
          break;
        case "svg":
          console.log(renderSvg(result));
          break;
        default:
          renderTerminal(result, {
            quiet: options.quiet,
            verbose: options.verbose,
          });
          break;
      }

      process.exitCode =
        threshold !== null && isBelowThreshold(result.totalScore, threshold)
          ? 1
          : 0;
    } catch (err) {
      console.error(chalk.red("\n  Error:"), (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Create a .codediag.yml config file")
  .action(() => {
    const configPath = resolve(".codediag.yml");

    if (existsSync(configPath)) {
      console.log(chalk.yellow("\n  .codediag.yml already exists.\n"));
      return;
    }

    const template = `# codediag configuration
# https://github.com/sabahattink/codediag#config

threshold: 70

ignore:
  - node_modules
  - dist
  - .git
  - coverage

analyzers:
  api: true
  security: true
  dependencies: true
  testing: true
  structure: true
`;

    writeFileSync(configPath, template, "utf-8");
    console.log(chalk.green("\n  Created .codediag.yml\n"));
  });

program.parse();
