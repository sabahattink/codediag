export interface StackInfo {
  framework: "nestjs" | "nextjs" | "express" | "generic" | "unknown";
  language: "typescript" | "javascript";
  orm: string | null;
  hasDocker: boolean;
  hasEnvFile: boolean;
  hasPrisma: boolean;
  hasTests: boolean;
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
}

export interface DiagnosticIssue {
  severity: "critical" | "warning" | "info";
  rule: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

export interface AnalyzerResult {
  name: string;
  score: number;
  issues: DiagnosticIssue[];
  summary: string;
}

export type Grade = "A+" | "A" | "B+" | "B" | "C" | "D" | "F";

export interface SkippedFile {
  file: string;
  reason: "too-large" | "minified" | "unreadable";
}

export interface SkippedSummary {
  total: number;
  tooLarge: number;
  minified: number;
  unreadable: number;
  files: SkippedFile[];
}

export interface ScanResult {
  project: string;
  stack: StackInfo;
  analyzers: AnalyzerResult[];
  totalScore: number;
  grade: Grade;
  timestamp: string;
  skipped?: SkippedSummary;
}

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  jest?: { coverageThreshold?: unknown };
  eslintConfig?: unknown;
  prettier?: unknown;
}

export interface CodediagConfig {
  threshold: number;
  ignore: string[];
  maxFileSizeKb: number;
  analyzers: {
    api: boolean;
    security: boolean;
    dependencies: boolean;
    testing: boolean;
    structure: boolean;
  };
}

export type AnalyzerKey = keyof CodediagConfig["analyzers"];

export const DEFAULT_CONFIG: CodediagConfig = {
  threshold: 70,
  ignore: ["node_modules", "dist", ".git", "coverage"],
  maxFileSizeKb: 512,
  analyzers: {
    api: true,
    security: true,
    dependencies: true,
    testing: true,
    structure: true,
  },
};
