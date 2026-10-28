import { readFileSync } from "fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  define: {
    __CODEDIAG_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
