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

export interface ScanResult {
  project: string;
  stack: StackInfo;
  analyzers: AnalyzerResult[];
  totalScore: number;
  grade: string;
  timestamp: string;
}

export const ANALYZER_KEYS = ["api", "security", "dependencies", "testing", "structure"] as const;

export type AnalyzerKey = (typeof ANALYZER_KEYS)[number];

export interface CodediagConfig {
  threshold: number;
  ignore: string[];
  analyzers: Record<AnalyzerKey, boolean>;
}

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

/** Shared inputs for analyzers that walk the project tree. */
export interface AnalyzerContext {
  /** Entries from `.codediag.yml` `ignore` (always includes the defaults). */
  ignore: readonly string[];
  stack: StackInfo;
}

/** Receives progress updates while a scan runs (the CLI maps this to a spinner). */
export interface ProgressReporter {
  start(text: string): void;
  succeed(text: string): void;
}
