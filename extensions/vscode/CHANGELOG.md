# Changelog

## 0.4.0

- Run the CodeDiag 0.6 engine: Fastify analysis, JWT, cookie, template
  injection, prototype pollution, and configuration secret rules, and the
  redesigned HTML report.
- Add quick fixes to CodeDiag problems: suppress the rule on the flagged line
  or in the whole file with an inline directive whose reason you type, or open
  the rule's documentation. A directive left without a reason is not applied.
- Offer suppressions only in files whose directives the scanner reads and
  only for findings that are not already suppressed; never as the preferred
  fix.
- Link each problem's rule ID to its section of the rule reference.

## 0.3.0

- Run the CodeDiag 0.4 engine, which reports path traversal, server-side
  request forgery, open redirects, and reflected XSS.

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
