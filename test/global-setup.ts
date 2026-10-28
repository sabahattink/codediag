import { build } from "tsup";

/**
 * The CLI end-to-end tests execute `dist/index.js`, so build it once from the
 * current sources before any test file runs.
 */
export default async function setup(): Promise<void> {
  await build({ silent: true });
}
