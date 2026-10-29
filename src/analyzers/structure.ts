import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { ts } from "ts-morph";
import type { AnalyzerContext, AnalyzerResult, DiagnosticIssue } from "../types.js";
import { findFiles, findSubdirectories } from "../utils/files.js";
import { readPackageJsonOrNull } from "../utils/package-json.js";

const LINTER_CONFIGS = [
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts",
  ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  "biome.json", "biome.jsonc",
];
const FORMATTER_CONFIGS = [
  ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.json", ".prettierrc.json5",
  ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.toml",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
  "biome.json", "biome.jsonc", // biome handles formatting too
];
const NEST_SHARED_DIRS = ["common", "shared", "config", "utils", "core", "database", "auth"];
const MAX_TSCONFIG_EXTENDS_DEPTH = 5;
const MIN_WELL_ORGANIZED_RATIO = 0.7;

type TsconfigStrict = { status: "ok"; strict: boolean } | { status: "invalid" };

function resolveExtends(fromDir: string, projectPath: string, spec: string): string | null {
  const candidates = spec.startsWith(".") || spec.startsWith("/")
    ? [join(fromDir, spec), join(fromDir, `${spec}.json`)]
    : [join(projectPath, "node_modules", spec), join(projectPath, "node_modules", `${spec}.json`), join(projectPath, "node_modules", spec, "tsconfig.json")];
  return candidates.find((c) => existsSync(c) && c.endsWith(".json")) ?? null;
}

/**
 * Reads `compilerOptions.strict`, tolerating comments/trailing commas (tsc's own
 * parser) and following `extends` chains. The nearest definition wins.
 */
function readTsconfigStrict(path: string, projectPath: string, depth = 0): TsconfigStrict {
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  if (error || typeof config !== "object" || config === null) return { status: "invalid" };

  const options: unknown = config.compilerOptions;
  if (typeof options === "object" && options !== null && "strict" in options) {
    return { status: "ok", strict: options.strict === true };
  }

  if (depth < MAX_TSCONFIG_EXTENDS_DEPTH) {
    const ext: unknown = config.extends;
    const specs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((e): e is string => typeof e === "string") : [];
    // With an array, later entries override earlier ones.
    for (const spec of [...specs].reverse()) {
      const parentPath = resolveExtends(dirname(path), projectPath, spec);
      if (!parentPath) continue;
      const parent = readTsconfigStrict(parentPath, projectPath, depth + 1);
      if (parent.status === "ok" && parent.strict) return parent;
    }
  }
  return { status: "ok", strict: false };
}

export async function analyzeStructure(projectPath: string, ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const pkg = readPackageJsonOrNull(projectPath);
  const framework = ctx.stack.framework;

  // 1. README exists and is meaningful
  checksRun++;
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, "utf-8");
    if (content.length > 100) {
      checksPassed++;
    } else {
      checksPassed += 0.5;
      issues.push({ severity: "info", rule: "short-readme", message: "README.md exists but is very short", fix: "Add project description, install instructions, usage examples" });
    }
  } else {
    issues.push({ severity: "warning", rule: "no-readme", message: "No README.md found", fix: "Create a README.md with project documentation" });
  }

  // 2. .editorconfig
  checksRun++;
  if (existsSync(join(projectPath, ".editorconfig"))) {
    checksPassed++;
  } else {
    issues.push({ severity: "info", rule: "no-editorconfig", message: "No .editorconfig found", fix: "Create .editorconfig for consistent formatting across editors" });
  }

  // 3. Linter (ESLint or Biome)
  checksRun++;
  const hasLinter = LINTER_CONFIGS.some((f) => existsSync(join(projectPath, f))) || pkg?.raw.eslintConfig !== undefined;
  if (hasLinter) { checksPassed++; } else {
    issues.push({ severity: "warning", rule: "no-linter", message: "No ESLint or Biome config found", fix: "Set up ESLint or Biome for code quality enforcement" });
  }

  // 4. Formatter (Prettier or Biome)
  checksRun++;
  const hasFormatter = FORMATTER_CONFIGS.some((f) => existsSync(join(projectPath, f))) || pkg?.raw.prettier !== undefined;
  if (hasFormatter) { checksPassed++; } else {
    issues.push({ severity: "info", rule: "no-formatter", message: "No Prettier or Biome formatter config", fix: "Set up Prettier or Biome for consistent code formatting" });
  }

  // 5. tsconfig strict mode
  const tsconfigPath = join(projectPath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    checksRun++;
    const strict = readTsconfigStrict(tsconfigPath, projectPath);
    if (strict.status === "invalid") {
      issues.push({ severity: "info", rule: "invalid-tsconfig", message: "Cannot parse tsconfig.json" });
    } else if (strict.strict) {
      checksPassed++;
    } else {
      issues.push({ severity: "warning", rule: "no-strict-mode", message: "TypeScript strict mode is not enabled", fix: 'Set "strict": true in tsconfig.json compilerOptions' });
    }
  }

  // 6. Source directory (Next.js projects may keep app/ or pages/ at the root)
  checksRun++;
  const sourceDirs = framework === "nextjs" ? ["src", "app", "pages"] : ["src"];
  if (sourceDirs.some((d) => existsSync(join(projectPath, d)))) {
    checksPassed++;
  } else {
    issues.push({ severity: "warning", rule: "no-src-dir", message: `No ${sourceDirs.join("/ or ")}/ directory found`, fix: "Organize source code under a src/ directory" });
  }

  // 7. NestJS module organization (feature folders with module or controller + service)
  if (framework === "nestjs" && existsSync(join(projectPath, "src"))) {
    checksRun++;
    const featureDirs = (await findSubdirectories(projectPath, "src", ctx.ignore))
      .filter((dir) => !NEST_SHARED_DIRS.includes(dir.slice("src/".length)));

    let wellOrganized = 0;
    for (const dir of featureDirs) {
      const files = await findFiles(projectPath, `${dir}/*.ts`, ctx.ignore);
      const hasModule = files.some((f) => f.endsWith(".module.ts"));
      const hasController = files.some((f) => f.endsWith(".controller.ts"));
      const hasService = files.some((f) => f.endsWith(".service.ts"));
      if (hasModule || (hasController && hasService)) wellOrganized++;
    }

    if (featureDirs.length === 0 || wellOrganized >= featureDirs.length * MIN_WELL_ORGANIZED_RATIO) {
      checksPassed++;
    } else {
      issues.push({ severity: "info", rule: "poor-module-org", message: `${wellOrganized}/${featureDirs.length} feature dirs properly organized`, fix: "Each feature should have module + controller + service files" });
    }
  }

  // 8. .env.example
  checksRun++;
  const hasEnv = existsSync(join(projectPath, ".env"));
  const hasEnvExample = existsSync(join(projectPath, ".env.example"));
  if (!hasEnv || hasEnvExample) {
    checksPassed++;
  } else {
    issues.push({ severity: "info", rule: "no-env-example", message: ".env exists but no .env.example for reference", fix: "Create .env.example with placeholder values" });
  }

  const score = checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return { name: "Structure", score, issues, summary: `${Math.round(checksPassed)}/${checksRun} checks passed` };
}
