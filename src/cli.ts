import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { CONFIG_FILE_NAMES, CONFIG_TEMPLATE, ConfigError, resolveThreshold, type LoadedConfig } from "./config.js";
import { renderJson } from "./reporters/json.js";
import { renderMarkdown } from "./reporters/markdown.js";
import { renderTerminal } from "./reporters/terminal.js";
import type { ScanOptions } from "./scanner.js";
import { EXIT_CODES, exitCodeForScore, type ExitCode } from "./scoring.js";
import type { ProgressReporter, ScanResult } from "./types.js";
import { VERSION } from "./version.js";

const FORMATS = ["terminal", "json", "md"] as const;
type Format = (typeof FORMATS)[number];

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stderr (where the spinner draws) is an interactive terminal. */
  isTTY: boolean;
}

export interface ScanCommandOptions {
  format: string;
  threshold?: string;
  ci?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface ScanCommandDeps {
  scan(projectPath: string, options: ScanOptions): Promise<ScanResult>;
  loadConfig(projectPath: string): LoadedConfig;
  createProgress(enabled: boolean): ProgressReporter;
  io: CliIO;
}

function isFormat(value: string): value is Format {
  return FORMATS.some((f) => f === value);
}

function render(result: ScanResult, format: Format, options: ScanCommandOptions): string {
  switch (format) {
    case "json": return renderJson(result);
    case "md": return renderMarkdown(result, { verbose: options.verbose });
    case "terminal": return renderTerminal(result, { quiet: options.quiet, verbose: options.verbose });
  }
}

/**
 * Runs `codediag scan` and returns the exit code: 0 at/above the threshold,
 * 1 below it, 2 on invalid input or a failed scan. Only the report is written
 * to stdout; progress, warnings and errors go to stderr.
 */
export async function runScanCommand(path: string, options: ScanCommandOptions, deps: ScanCommandDeps): Promise<ExitCode> {
  const { io } = deps;
  const targetPath = resolve(path);
  const format = options.ci ? "json" : options.format;
  let progress: ProgressReporter | undefined;

  try {
    if (!isFormat(format)) {
      throw new ConfigError(`Unknown format "${format}" (expected terminal, json or md)`);
    }
    const { config } = deps.loadConfig(targetPath);
    const threshold = resolveThreshold(options.threshold, config);

    progress = deps.createProgress(format === "terminal" && !options.quiet && io.isTTY);
    const result = await deps.scan(targetPath, { config, progress });

    io.stdout(`${render(result, format, options)}\n`);
    const code = exitCodeForScore(result.totalScore, threshold);
    if (code === EXIT_CODES.belowThreshold) {
      io.stderr(`${chalk.red("✖")} Score ${result.totalScore}/100 is below the threshold of ${threshold}\n`);
    }
    return code;
  } catch (err) {
    progress?.stop();
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`\n  ${chalk.red("Error:")} ${message}\n\n`);
    return EXIT_CODES.error;
  }
}

/** ora spinner on stderr, or a no-op when disabled. */
export function createSpinnerProgress(enabled: boolean): ProgressReporter {
  if (!enabled) return { start: () => {}, succeed: () => {}, stop: () => {} };
  const spinner = ora({ color: "cyan", stream: process.stderr });
  return {
    start: (text) => { spinner.start(chalk.dim(text)); },
    succeed: (text) => { spinner.succeed(chalk.dim(text)); },
    stop: () => { spinner.stop(); },
  };
}

export function runInitCommand(cwd: string, io: CliIO): ExitCode {
  const existing = CONFIG_FILE_NAMES.find((name) => existsSync(join(cwd, name)));
  if (existing) {
    io.stdout(chalk.yellow(`\n  ${existing} already exists.\n\n`));
    return EXIT_CODES.ok;
  }
  writeFileSync(join(cwd, CONFIG_FILE_NAMES[0]), CONFIG_TEMPLATE, "utf-8");
  io.stdout(chalk.green(`\n  Created ${CONFIG_FILE_NAMES[0]}\n\n`));
  return EXIT_CODES.ok;
}

export function createProgram(deps: ScanCommandDeps, setExitCode: (code: number) => void): Command {
  const program = new Command();
  // Must precede .command() so subcommands inherit it; the caller maps CommanderError to exit codes.
  program.exitOverride();

  program
    .name("codediag")
    .description(
      chalk.bold("codediag") +
        " — Diagnose your code before you ship.\n\n" +
        "  Automated project health scanner for NestJS, Express, Next.js and Node.js.\n" +
        "  https://codediag.dev"
    )
    .version(VERSION, "-v, --version");

  program
    .command("scan")
    .description("Scan a project and generate a diagnostic report")
    .argument("[path]", "Project directory to scan", ".")
    .option("-f, --format <type>", "Output format: terminal, json, md", "terminal")
    .option("-t, --threshold <number>", "Minimum passing score; exit code 1 below it (default: config or 70)")
    .option("--ci", "CI mode: JSON output + exit code")
    .option("--quiet", "Show score only")
    .option("--verbose", "Show all issues including info")
    .addHelpText("after", "\nExit codes: 0 = score >= threshold, 1 = below threshold, 2 = error")
    .action(async (path: string, options: ScanCommandOptions) => {
      setExitCode(await runScanCommand(path, options, deps));
    });

  program
    .command("init")
    .description("Create a .codediag.yml config file in the current directory")
    .action(() => {
      setExitCode(runInitCommand(process.cwd(), deps.io));
    });

  return program;
}
