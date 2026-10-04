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
  /** Line-number-independent identity used by SARIF and baselines. */
  fingerprint?: string;
  /** The reported rule this finding is a consequence of; it is not penalized. */
  causedBy?: string;
  /** Set when a codediag-ignore comment suppresses the finding. */
  suppression?: { kind: "inSource"; justification: string };
  /** Set when the finding's fingerprint is in the baseline passed to the scan. */
  baseline?: boolean;
  /** How certain the analyzer is; "low" findings rely on naming heuristics. */
  confidence?: "high" | "medium" | "low";
}

export interface BaselineSummary {
  /** Findings matched by the baseline. */
  matched: number;
  /** Baseline fingerprints that no longer match any finding. */
  fixed: number;
}

export type RuleSetting = "off" | DiagnosticIssue["severity"];

export interface ScoreBreakdownEntry {
  rule: string;
  count: number;
  penalty: number;
}

export type ScoringVersion = 1 | 2;

export interface AnalyzerResult {
  name: string;
  score: number;
  issues: DiagnosticIssue[];
  summary: string;
  /** Scoring version 2: the points each rule cost this analyzer. */
  scoreBreakdown?: ScoreBreakdownEntry[];
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
  scoringVersion?: ScoringVersion;
  baseline?: BaselineSummary;
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
  scoring: { version: ScoringVersion };
  rules: Record<string, RuleSetting>;
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
  scoring: { version: 2 },
  rules: {},
  analyzers: {
    api: true,
    security: true,
    dependencies: true,
    testing: true,
    structure: true,
  },
};
