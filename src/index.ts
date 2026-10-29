import { CommanderError } from "commander";
import { createProgram, createSpinnerProgress } from "./cli.js";
import { loadConfig } from "./config.js";
import { scan } from "./scanner.js";
import { EXIT_CODES } from "./scoring.js";

const program = createProgram(
  {
    scan,
    loadConfig,
    createProgress: createSpinnerProgress,
    io: {
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
      isTTY: process.stderr.isTTY === true,
    },
  },
  (code) => { process.exitCode = code; }
);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // exitOverride(): Commander already printed help/version/usage errors.
  if (!(err instanceof CommanderError)) throw err;
  process.exitCode = err.exitCode === 0 ? EXIT_CODES.ok : EXIT_CODES.error;
}
