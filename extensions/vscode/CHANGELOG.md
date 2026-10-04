# Changelog

## 0.2.0

- Run the CodeDiag 0.3 engine: gitignore-aware discovery, explainable
  version 2 scores, suppressions, baselines, and more precise Express,
  NestJS, and security findings.
- Hide suppressed and baseline findings from the Problems panel and status bar
  counts.
- Scans triggered by saving reuse the last dependency audit of the same lock
  file instead of running the package manager.

## 0.1.0

- Add workspace scans backed by the CodeDiag analyzer engine.
- Publish located findings to the VS Code Problems panel.
- Add HTML report, review-first fix plan, and AI review prompt commands.
- Add optional debounced scanning after save.
