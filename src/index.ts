import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { isBelowThreshold, loadConfig, parseThreshold } from "./config.js";
import { loadBaseline } from "./core/baseline.js";
import { renderHtml } from "./reporters/html.js";
import { renderAiPrompt, renderFixPlan } from "./reporters/fix-plan.js";
import { renderJson } from "./reporters/json.js";
import { renderMarkdown } from "./reporters/markdown.js";
import { renderSarif } from "./reporters/sarif.js";
import { renderSvg } from "./reporters/svg.js";
import { renderTerminal } from "./reporters/terminal.js";
import { scan } from "./scanner.js";
import { getPackageVersion } from "./version.js";

const OUTPUT_FORMATS = new Set([
  "terminal",
  "json",
  "sarif",
  "md",
  "svg",
  "html",
  "fixes",
  "prompt",
]);

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
    "Output format: terminal, json, sarif, md, svg, html, fixes, prompt",
    "terminal",
  )
  .option("-t, --threshold <number>", "Minimum passing score")
  .option(
    "--ci",
    "CI mode: JSON output unless --format is given, and enforce the threshold",
  )
  .option("--quiet", "Show score only")
  .option("--verbose", "Show all issues including info")
  .option(
    "--baseline <report>",
    "JSON report whose findings are accepted and excluded from the score",
  )
  .option(
    "--update-baseline <report>",
    "Write the scan's JSON report to this path for use with --baseline",
  )
  .action(async (path: string, options, command: Command) => {
    const targetPath = resolve(path);
    // --ci implies JSON only when no output format was chosen explicitly.
    const explicitFormat = command.getOptionValueSource("format") === "cli";
    const format = options.ci && !explicitFormat ? "json" : options.format;

    try {
      if (!OUTPUT_FORMATS.has(format)) {
        throw new Error(
          `Unknown output format "${format}". Expected terminal, json, sarif, md, svg, html, fixes, or prompt.`,
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
      const baseline = options.baseline
        ? loadBaseline(resolve(options.baseline))
        : undefined;
      const result = await scan(targetPath, config, { baseline });
      if (options.updateBaseline) {
        const baselinePath = resolve(options.updateBaseline);
        mkdirSync(dirname(baselinePath), { recursive: true });
        writeFileSync(
          baselinePath,
          `${JSON.stringify(result, null, 2)}\n`,
          "utf-8",
        );
      }

      switch (format) {
        case "json":
          renderJson(result);
          break;
        case "sarif":
          console.log(renderSarif(result).trimEnd());
          break;
        case "md":
          console.log(renderMarkdown(result));
          break;
        case "svg":
          console.log(renderSvg(result));
          break;
        case "html":
          console.log(renderHtml(result));
          break;
        case "fixes":
          console.log(renderFixPlan(result));
          break;
        case "prompt":
          console.log(renderAiPrompt(result));
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
  .argument("[path]", "Project directory to configure", ".")
  .action((path: string) => {
    const projectPath = resolve(path);
    if (!existsSync(projectPath)) {
      console.error(
        chalk.red("\n  Error:"),
        `Directory not found: ${projectPath}`,
      );
      process.exit(1);
    }
    const configPath = resolve(projectPath, ".codediag.yml");

    if (existsSync(configPath)) {
      console.log(chalk.yellow("\n  .codediag.yml already exists.\n"));
      return;
    }

    const template = `# codediag configuration
# https://github.com/sabahattink/codediag#config

threshold: 70

scoring:
  version: 2

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

# Turn rules off or change their severity (rule IDs: docs/rules.md).
# rules:
#   missing-swagger: off
#   open-cors: critical

# Code files larger than this are skipped (KiB).
# maxFileSizeKb: 512
`;

    writeFileSync(configPath, template, "utf-8");
    console.log(chalk.green(`\n  Created ${configPath}\n`));
  });

program.parse();
