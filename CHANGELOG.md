# Changelog

All notable changes to CodeDiag are documented in this file.

## [Unreleased]

### Added

- Express API health analysis for route authentication, request validation,
  centralized error handling, and runtime health endpoints.
- Express JavaScript and TypeScript integration coverage.
- Next.js App Router and Pages Router API analysis with frontend-only projects
  treated as not applicable.
- Framework-specific Express and Next.js integration fixtures.
- Dependency-free SVG score badge output through `--format svg`.
- Validated `.codediag.yml` loading with analyzer selection and ignore patterns.
- Regression tests for configuration, threshold handling, package version, and
  npm audit parsing.
- A single `npm run check` command for local and CI validation.
- Enforced Biome linting and formatting plus EditorConfig defaults.

### Changed

- Project ownership and links now use the canonical Sabahattin Kalkan identity.
- CLI version is read from `package.json`.
- Threshold failures now return exit code 1 in every output mode.
- Plain scans remain informational unless a config, `--threshold`, or `--ci`
  enables a quality gate.
- Dependency auditing preserves vulnerability reports when `npm audit` exits
  non-zero.
- Security and structure checks apply framework-specific expectations only
  when the matching framework is detected.

### Removed

- Tracked local Claude settings.
