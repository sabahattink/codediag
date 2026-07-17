import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { glob } from "glob";
import { Project } from "ts-morph";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

const LINTER_CONFIGS = [
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
  "eslint.config.ts",
  "eslint.config.cts",
  "eslint.config.mts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "biome.json",
  "biome.jsonc",
];

const FORMATTER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "biome.json",
  "biome.jsonc",
];

const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template"];

interface PackageMetadata {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  eslintConfig?: unknown;
  prettier?: unknown;
}

function parsePackageMetadata(projectPath: string): PackageMetadata {
  try {
    return JSON.parse(
      readFileSync(join(projectPath, "package.json"), "utf-8"),
    ) as PackageMetadata;
  } catch {
    // Invalid package metadata is reported by the dependency analyzer.
    return {};
  }
}

function findConfigUp(
  projectPath: string,
  fileNames: string[],
  maxParentDepth = 3,
): string | undefined {
  let directory = projectPath;

  for (let depth = 0; depth <= maxParentDepth; depth++) {
    for (const fileName of fileNames) {
      const candidate = join(directory, fileName);
      if (existsSync(candidate)) return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return undefined;
}

function findReadme(projectPath: string): string | undefined {
  try {
    const preferredNames = [
      "readme.md",
      "readme.mdx",
      "readme.rst",
      "readme.txt",
      "readme",
    ];
    const entries = readdirSync(projectPath);
    const byLowerName = new Map(
      entries.map((entry) => [entry.toLowerCase(), entry]),
    );

    for (const name of preferredNames) {
      const actualName = byLowerName.get(name);
      if (actualName) return join(projectPath, actualName);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function meaningfulReadmeLength(content: string): number {
  return content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`#>*_|~=-]/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function displayPath(projectPath: string, filePath: string): string {
  return relative(projectPath, filePath).replace(/\\/g, "/") || ".";
}

function rootEnvFiles(projectPath: string): string[] {
  try {
    return readdirSync(projectPath).filter(
      (entry) =>
        /^\.env(?:\..+)?$/.test(entry) && !ENV_TEMPLATES.includes(entry),
    );
  } catch {
    return [];
  }
}

async function analyzeNestOrganization(
  projectPath: string,
  ignore: string[],
  issues: DiagnosticIssue[],
): Promise<boolean> {
  const srcPath = join(projectPath, "src");
  if (!existsSync(srcPath)) {
    issues.push({
      severity: "warning",
      rule: "no-src-dir",
      message: "No src/ directory found",
      fix: "Organize NestJS source code under a src/ directory",
    });
    return false;
  }

  const scanIgnore = [
    ...ignore,
    "**/*.spec.*",
    "**/*.test.*",
    "**/{test,tests,__tests__,e2e}/**",
  ];

  try {
    const [moduleFiles, controllerFiles, serviceFiles] = await Promise.all([
      glob("src/**/*.module.{ts,js,mjs,cjs}", {
        cwd: projectPath,
        ignore: scanIgnore,
      }),
      glob("src/**/*.controller.{ts,js,mjs,cjs}", {
        cwd: projectPath,
        ignore: scanIgnore,
      }),
      glob("src/**/*.service.{ts,js,mjs,cjs}", {
        cwd: projectPath,
        ignore: scanIgnore,
      }),
    ]);

    if (moduleFiles.length === 0) {
      issues.push({
        severity: "warning",
        rule: "no-nest-module",
        message: "No NestJS module files found under src/",
        fix: "Add an application or feature module (*.module.ts)",
      });
      return false;
    }

    const moduleDirectories = new Set(
      moduleFiles.map((file) => dirname(file).replace(/\\/g, "/")),
    );
    const featureDirectories = new Set(
      [...controllerFiles, ...serviceFiles].map((file) =>
        dirname(file).replace(/\\/g, "/"),
      ),
    );

    if (featureDirectories.size === 0) return true;

    const hasFeatureModule = (featureDirectory: string): boolean => {
      let directory = featureDirectory;
      while (directory !== "src" && directory !== ".") {
        if (moduleDirectories.has(directory)) return true;
        directory = dirname(directory).replace(/\\/g, "/");
      }
      return featureDirectory === "src" && moduleDirectories.has("src");
    };
    const unmodularized = [...featureDirectories].filter(
      (directory) => !hasFeatureModule(directory),
    );
    if (unmodularized.length === 0) return true;

    const organizedCount = featureDirectories.size - unmodularized.length;
    issues.push({
      severity: "info",
      rule: "poor-module-org",
      message: `${organizedCount}/${featureDirectories.size} controller/service directories have a colocated module`,
      file: unmodularized.sort()[0],
      fix: "Add a feature module beside each feature controller or service",
    });
    return false;
  } catch {
    issues.push({
      severity: "warning",
      rule: "structure-scan-failed",
      message: "Could not inspect NestJS module organization",
      fix: "Check source directory permissions and ignore patterns",
    });
    return false;
  }
}

export async function analyzeStructure(
  projectPath: string,
  ignore: string[] = ["node_modules/**", "dist/**", ".git/**", "coverage/**"],
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const pkg = parsePackageMetadata(projectPath);
  const hasDependency = (name: string): boolean =>
    Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  const isNestjs = hasDependency("@nestjs/core");
  const tsconfigPath = join(projectPath, "tsconfig.json");
  const isTypescript = existsSync(tsconfigPath) || hasDependency("typescript");

  // 1. README exists and contains useful prose, not only badges or markup.
  checksRun++;
  const readmePath = findReadme(projectPath);
  if (readmePath) {
    const content = readFileSync(readmePath, "utf-8");
    if (meaningfulReadmeLength(content) >= 100) {
      checksPassed++;
    } else {
      issues.push({
        severity: "info",
        rule: "short-readme",
        message: `${displayPath(projectPath, readmePath)} contains little explanatory content`,
        file: displayPath(projectPath, readmePath),
        fix: "Add a project description, installation steps, and usage examples",
      });
    }
  } else {
    issues.push({
      severity: "warning",
      rule: "no-readme",
      message: "No README file found",
      fix: "Create a README with project documentation",
    });
  }

  // 2. EditorConfig can be inherited from a monorepo root.
  checksRun++;
  if (findConfigUp(projectPath, [".editorconfig"])) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-editorconfig",
      message: "No .editorconfig found in this project or its parent workspace",
      fix: "Create .editorconfig for consistent formatting across editors",
    });
  }

  // 3. Linter config can live in a file, package.json, or a parent workspace.
  checksRun++;
  if (
    pkg.eslintConfig !== undefined ||
    findConfigUp(projectPath, LINTER_CONFIGS)
  ) {
    checksPassed++;
  } else {
    issues.push({
      severity: "warning",
      rule: "no-linter",
      message: "No ESLint or Biome config found",
      fix: "Set up ESLint or Biome for code quality enforcement",
    });
  }

  // 4. Formatter config can also be embedded in package.json or inherited.
  checksRun++;
  if (
    pkg.prettier !== undefined ||
    findConfigUp(projectPath, FORMATTER_CONFIGS)
  ) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-formatter",
      message: "No Prettier or Biome formatter config found",
      fix: "Set up Prettier or Biome for consistent code formatting",
    });
  }

  // 5. Resolve JSONC and inherited TypeScript compiler options.
  if (isTypescript) {
    checksRun++;
    if (!existsSync(tsconfigPath)) {
      issues.push({
        severity: "warning",
        rule: "no-tsconfig",
        message: "TypeScript is installed but tsconfig.json is missing",
        fix: "Create a tsconfig.json with strict mode enabled",
      });
    } else {
      try {
        const project = new Project({
          tsConfigFilePath: tsconfigPath,
          skipAddingFilesFromTsConfig: true,
        });
        if (project.getCompilerOptions().strict === true) {
          checksPassed++;
        } else {
          issues.push({
            severity: "warning",
            rule: "no-strict-mode",
            message: "TypeScript strict mode is not enabled",
            file: "tsconfig.json",
            fix: 'Set "strict": true in tsconfig.json compilerOptions',
          });
        }
      } catch {
        issues.push({
          severity: "warning",
          rule: "invalid-tsconfig",
          message: "Cannot resolve tsconfig.json compiler options",
          file: "tsconfig.json",
          fix: "Fix invalid JSONC or an unresolved extends reference",
        });
      }
    }
  }

  // 6. NestJS feature directories with controllers or services need modules.
  if (isNestjs) {
    checksRun++;
    if (await analyzeNestOrganization(projectPath, ignore, issues)) {
      checksPassed++;
    }
  }

  // 7. Any environment-specific file requires a shareable template.
  checksRun++;
  const envFiles = rootEnvFiles(projectPath);
  const envTemplate = ENV_TEMPLATES.find((name) =>
    existsSync(join(projectPath, name)),
  );
  if (envFiles.length === 0 || envTemplate) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-env-example",
      message: `${envFiles.sort().join(", ")} found without an environment template`,
      file: envFiles.sort()[0],
      fix: "Create .env.example, .env.sample, or .env.template with placeholder values",
    });
  }

  const score =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return {
    name: "Structure",
    score,
    issues,
    summary: `${checksPassed}/${checksRun} checks passed`,
  };
}
