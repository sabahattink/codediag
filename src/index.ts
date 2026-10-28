import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { writeFileSync, existsSync } from "fs";
import { scan } from "./scanner.js";
import { renderTerminal } from "./reporters/terminal.js";
import { renderJson } from "./reporters/json.js";
import type { ScanResult } from "./types.js";
import { VERSION } from "./version.js";

function renderMarkdown(result: ScanResult): string {
  const lines = [
    `## codediag \u2014 Diagnostic Report`,
    ``,
    `| Metric | Score |`,
    `|--------|-------|`,
  ];

  for (const a of result.analyzers) {
    const icon = a.score >= 80 ? "\u2705" : a.score >= 60 ? "\u26A0\uFE0F" : "\u274C";
    lines.push(`| ${icon} ${a.name} | ${a.score}/100 |`);
  }

  lines.push(`| **Total** | **${result.totalScore}/100 (${result.grade})** |`);
  lines.push(``);
  lines.push(`> Scanned by [codediag](https://codediag.dev) on ${new Date().toLocaleDateString()}`);

  return lines.join("\n");
}

const program = new Command();

program
  .name("codediag")
  .description(
    chalk.bold("codediag") +
      " \u2014 Diagnose your code before you ship.\n\n" +
      "  Automated project health scanner for NestJS and beyond.\n" +
      "  https://codediag.dev"
  )
  .version(VERSION, "-v, --version");

program
  .command("scan")
  .description("Scan a project and generate a diagnostic report")
  .argument("[path]", "Project directory to scan", ".")
  .option("-f, --format <type>", "Output format: terminal, json, md", "terminal")
  .option("-t, --threshold <number>", "Minimum passing score", "70")
  .option("--ci", "CI mode: JSON output + exit code")
  .option("--quiet", "Show score only")
  .option("--verbose", "Show all issues including info")
  .action(async (path: string, options) => {
    const targetPath = resolve(path);
    const threshold = parseInt(options.threshold, 10);
    const format = options.ci ? "json" : options.format;

    try {
      const result = await scan(targetPath);

      switch (format) {
        case "json":
          renderJson(result);
          break;
        case "md":
          console.log(renderMarkdown(result));
          break;
        default:
          renderTerminal(result, { quiet: options.quiet, verbose: options.verbose });
          break;
      }

      if (options.ci) {
        process.exit(result.totalScore >= threshold ? 0 : 1);
      }
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
# https://codediag.dev/docs/config

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
