import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { coverage: { provider: "v8", thresholds: { lines: 80, branches: 70 } } },
});
