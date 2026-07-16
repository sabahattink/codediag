import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackInfo } from "../types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectStack(projectPath: string): StackInfo {
  const info: StackInfo = {
    framework: "unknown",
    language: "javascript",
    orm: null,
    hasDocker: false,
    hasEnvFile: false,
    hasPrisma: false,
    hasTests: false,
    packageManager: "unknown",
  };

  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return info;

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return info;
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  // Language
  if (allDeps.typescript || existsSync(join(projectPath, "tsconfig.json"))) {
    info.language = "typescript";
  }

  // Framework
  if (
    allDeps["@nestjs/core"] ||
    existsSync(join(projectPath, "nest-cli.json"))
  ) {
    info.framework = "nestjs";
  } else if (
    allDeps.next ||
    existsSync(join(projectPath, "next.config.js")) ||
    existsSync(join(projectPath, "next.config.mjs")) ||
    existsSync(join(projectPath, "next.config.ts"))
  ) {
    info.framework = "nextjs";
  } else if (allDeps.express) {
    info.framework = "express";
  } else if (pkg.dependencies || pkg.devDependencies) {
    info.framework = "generic";
  }

  // ORM
  if (
    allDeps.prisma ||
    allDeps["@prisma/client"] ||
    existsSync(join(projectPath, "prisma", "schema.prisma"))
  ) {
    info.orm = "prisma";
    info.hasPrisma = true;
  } else if (allDeps.typeorm) {
    info.orm = "typeorm";
  } else if (allDeps.sequelize) {
    info.orm = "sequelize";
  } else if (allDeps.mongoose) {
    info.orm = "mongoose";
  } else if (allDeps["drizzle-orm"]) {
    info.orm = "drizzle";
  }

  // Docker
  info.hasDocker =
    existsSync(join(projectPath, "Dockerfile")) ||
    existsSync(join(projectPath, "docker-compose.yml")) ||
    existsSync(join(projectPath, "docker-compose.yaml"));

  // Env
  info.hasEnvFile =
    existsSync(join(projectPath, ".env")) ||
    existsSync(join(projectPath, ".env.local")) ||
    existsSync(join(projectPath, ".env.example"));

  // Tests
  info.hasTests =
    existsSync(join(projectPath, "test")) ||
    existsSync(join(projectPath, "tests")) ||
    existsSync(join(projectPath, "__tests__")) ||
    existsSync(join(projectPath, "e2e"));

  // Package manager
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) {
    info.packageManager = "pnpm";
  } else if (existsSync(join(projectPath, "yarn.lock"))) {
    info.packageManager = "yarn";
  } else if (existsSync(join(projectPath, "package-lock.json"))) {
    info.packageManager = "npm";
  }

  return info;
}
