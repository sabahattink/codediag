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

export interface ScanResult {
  project: string;
  stack: StackInfo;
  analyzers: AnalyzerResult[];
  totalScore: number;
  grade: Grade;
  timestamp: string;
}

export interface CodediagConfig {
  threshold: number;
  ignore: string[];
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
  analyzers: {
    api: true,
    security: true,
    dependencies: true,
    testing: true,
    structure: true,
  },
};
