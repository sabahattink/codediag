import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzerResult, DiagnosticIssue } from "../types.js";

export async function analyzeStructure(
  projectPath: string,
): Promise<AnalyzerResult> {
  const issues: DiagnosticIssue[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const pkgPath = join(projectPath, "package.json");
  let isNestjs = false;

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      isNestjs = Boolean(
        pkg.dependencies?.["@nestjs/core"] ||
          pkg.devDependencies?.["@nestjs/core"],
      );
    } catch {
      // Invalid package metadata is reported by the dependency analyzer.
    }
  }

  // 1. README exists and is meaningful
  checksRun++;
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, "utf-8");
    if (content.length > 100) {
      checksPassed++;
    } else {
      checksPassed += 0.5;
      issues.push({
        severity: "info",
        rule: "short-readme",
        message: "README.md exists but is very short",
        fix: "Add project description, install instructions, usage examples",
      });
    }
  } else {
    issues.push({
      severity: "warning",
      rule: "no-readme",
      message: "No README.md found",
      fix: "Create a README.md with project documentation",
    });
  }

  // 2. .editorconfig
  checksRun++;
  if (existsSync(join(projectPath, ".editorconfig"))) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-editorconfig",
      message: "No .editorconfig found",
      fix: "Create .editorconfig for consistent formatting across editors",
    });
  }

  // 3. Linter (ESLint or Biome)
  checksRun++;
  const hasLinter =
    existsSync(join(projectPath, "eslint.config.js")) ||
    existsSync(join(projectPath, "eslint.config.mjs")) ||
    existsSync(join(projectPath, ".eslintrc.js")) ||
    existsSync(join(projectPath, ".eslintrc.json")) ||
    existsSync(join(projectPath, ".eslintrc.yml")) ||
    existsSync(join(projectPath, "biome.json")) ||
    existsSync(join(projectPath, "biome.jsonc"));

  if (hasLinter) {
    checksPassed++;
  } else {
    issues.push({
      severity: "warning",
      rule: "no-linter",
      message: "No ESLint or Biome config found",
      fix: "Set up ESLint or Biome for code quality enforcement",
    });
  }

  // 4. Formatter (Prettier)
  checksRun++;
  const hasFormatter =
    existsSync(join(projectPath, ".prettierrc")) ||
    existsSync(join(projectPath, ".prettierrc.js")) ||
    existsSync(join(projectPath, ".prettierrc.json")) ||
    existsSync(join(projectPath, ".prettierrc.yml")) ||
    existsSync(join(projectPath, "prettier.config.js")) ||
    existsSync(join(projectPath, "prettier.config.mjs")) ||
    existsSync(join(projectPath, "biome.json")); // biome handles formatting too

  if (hasFormatter) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-formatter",
      message: "No Prettier or Biome formatter config",
      fix: "Set up Prettier or Biome for consistent code formatting",
    });
  }

  // 5. tsconfig strict mode
  checksRun++;
  const tsconfigPath = join(projectPath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
      if (tsconfig.compilerOptions?.strict === true) {
        checksPassed++;
      } else {
        issues.push({
          severity: "warning",
          rule: "no-strict-mode",
          message: "TypeScript strict mode is not enabled",
          fix: 'Set "strict": true in tsconfig.json compilerOptions',
        });
      }
    } catch {
      issues.push({
        severity: "info",
        rule: "invalid-tsconfig",
        message: "Cannot parse tsconfig.json",
      });
    }
  }

  // 6. NestJS module organization
  if (isNestjs) {
    checksRun++;
    const srcPath = join(projectPath, "src");
    if (existsSync(srcPath)) {
      try {
        const srcEntries = readdirSync(srcPath);
        const featureDirs = srcEntries.filter((entry) => {
          const fullPath = join(srcPath, entry);
          return (
            statSync(fullPath).isDirectory() &&
            ![
              "common",
              "shared",
              "config",
              "utils",
              "core",
              "database",
              "auth",
            ].includes(entry)
          );
        });

        let wellOrganized = 0;
        for (const dir of featureDirs) {
          const dirPath = join(srcPath, dir);
          const files = readdirSync(dirPath);
          const hasModule = files.some((f) => f.endsWith(".module.ts"));
          const hasController = files.some((f) => f.endsWith(".controller.ts"));
          const hasService = files.some((f) => f.endsWith(".service.ts"));
          if (hasModule || (hasController && hasService)) wellOrganized++;
        }

        if (
          featureDirs.length === 0 ||
          wellOrganized >= featureDirs.length * 0.7
        ) {
          checksPassed++;
        } else {
          issues.push({
            severity: "info",
            rule: "poor-module-org",
            message: `${wellOrganized}/${featureDirs.length} feature dirs properly organized`,
            fix: "Each feature should have module + controller + service files",
          });
        }
      } catch {
        checksPassed++;
      }
    } else {
      issues.push({
        severity: "warning",
        rule: "no-src-dir",
        message: "No src/ directory found",
        fix: "Organize source code under a src/ directory",
      });
    }
  }

  // 7. .env.example
  checksRun++;
  const hasEnv = existsSync(join(projectPath, ".env"));
  const hasEnvExample = existsSync(join(projectPath, ".env.example"));
  if (!hasEnv || hasEnvExample) {
    checksPassed++;
  } else {
    issues.push({
      severity: "info",
      rule: "no-env-example",
      message: ".env exists but no .env.example for reference",
      fix: "Create .env.example with placeholder values",
    });
  }

  const score =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  return {
    name: "Structure",
    score,
    issues,
    summary: `${Math.round(checksPassed)}/${checksRun} checks passed`,
  };
}
