import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackInfo } from "../types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * A svelte.config file that configures SvelteKit, for workspace members whose
 * @sveltejs/kit dependency is hoisted. Plain Svelte with Vite has one too.
 */
function hasSvelteKitConfig(projectPath: string): boolean {
  return ["js", "mjs", "cjs", "ts"].some((extension) => {
    const path = join(projectPath, `svelte.config.${extension}`);
    try {
      return (
        existsSync(path) &&
        /@sveltejs\/(?:kit|adapter-)|\bkit\s*:/.test(
          readFileSync(path, "utf-8"),
        )
      );
    } catch {
      return false;
    }
  });
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
  } else if (allDeps["@sveltejs/kit"] || hasSvelteKitConfig(projectPath)) {
    // Checked before the servers below: a SvelteKit app may run behind an
    // Express or Polka server (adapter-node's handler), or call Hono and serve
    // tRPC (trpc-sveltekit) from its endpoints and hooks, while those servers
    // have no reason to install @sveltejs/kit.
    info.framework = "sveltekit";
  } else if (
    allDeps.next ||
    existsSync(join(projectPath, "next.config.js")) ||
    existsSync(join(projectPath, "next.config.mjs")) ||
    existsSync(join(projectPath, "next.config.ts"))
  ) {
    info.framework = "nextjs";
  } else if (allDeps.fastify) {
    // Checked before Express: Fastify apps may depend on express through
    // @fastify/express, while Express apps have no reason to install Fastify.
    info.framework = "fastify";
  } else if (allDeps.express) {
    info.framework = "express";
  } else if (allDeps.hono) {
    // Checked after Next.js, Fastify, and Express: those servers may import
    // Hono as a library (hono/client, hono/jwt helpers, a Next.js catch-all
    // route handler), while a Hono server has no reason to install them.
    info.framework = "hono";
  } else if (allDeps["@trpc/server"]) {
    // Checked last: tRPC usually runs inside one of the servers above, whose
    // API analyzers add the tRPC checks; this is a standalone tRPC server or
    // a package that only defines routers.
    info.framework = "trpc";
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
