import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/action.ts"],
    format: ["cjs"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: false,
    dts: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: ".cjs" }),
    esbuildOptions(options) {
      options.legalComments = "external";
    },
  },
]);
