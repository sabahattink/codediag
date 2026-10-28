import { readFileSync } from "fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __CODEDIAG_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "node_modules/**", "dist/**"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20_000,
  },
});
