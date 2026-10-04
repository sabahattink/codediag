# Suppressions, rule settings, and baselines

CodeDiag gives you three ways to decide which findings count. All three keep
the scan honest: nothing is hidden silently, and every decision is visible in
the JSON and SARIF reports.

| Need | Use | Scope |
| --- | --- | --- |
| A specific finding is acceptable | Inline suppression comment | One line or one file |
| A rule does not fit your project | `rules` in `.codediag.yml` | Whole project |
| Adopt CodeDiag on an existing codebase | Baseline report | Findings that exist today |

Suppressed and baseline findings stay in the JSON and SARIF output, but they do
not affect scores, thresholds, GitHub annotations, fix plans, AI prompts, or
VS Code diagnostics. Rule settings change findings before anything else sees
them. Scores only reflect these decisions with scoring version 2, the default.

## Inline suppressions

Put the directive on its own line, directly above the code it applies to, and
always give a reason after `--`:

```ts
// codediag-ignore-next-line unsafe-dynamic-code -- plugin code is signed and sandboxed
const run = new Function("context", pluginSource);
```

Suppress one or more rules for a whole file:

```ts
/* codediag-ignore-file tls-verification-disabled, open-cors -- local development proxy only */
```

Rules:

- Rule IDs come from the [rule reference](rules.md); separate several with
  commas or spaces.
- Stacked `codediag-ignore-next-line` comments all apply to the first code
  line below them.
- A directive without rule IDs or without a reason is **not applied** and is
  reported as `suppression-missing-reason`.
- A directive that matches nothing, or names an unknown rule, is reported as
  `unused-suppression`, so stale suppressions do not accumulate.
- Directives inside string literals or after code on the same line are
  ignored.

In SARIF, suppressed findings carry `suppressions: [{ "kind": "inSource",
"justification": "..." }]`, which GitHub Code Scanning shows as suppressed
alerts.

## Rule settings

Turn a rule off or change its severity for the whole project:

```yaml
rules:
  missing-swagger: off        # internal service without public API docs
  open-cors: critical         # stricter than the default warning
  missing-return-type: info
```

Valid settings are `off`, `info`, `warning`, and `critical`. Unknown rule IDs
fail the scan, like other invalid configuration.

## Baselines

A baseline lets you enforce a quality gate on new code without fixing every
existing finding first. Any CodeDiag JSON report works as a baseline; findings
are matched by their line-number-independent `fingerprint`, so moving code
does not break the match.

```bash
# Record today's findings once and commit the file.
codediag scan . --update-baseline .codediag-baseline.json

# In CI, only findings that are not in the baseline count.
codediag scan . --ci --threshold 80 --baseline .codediag-baseline.json
```

With a baseline, the JSON report includes `baseline: { matched, fixed }`
(`fixed` counts baseline findings that no longer occur) and every matched
finding has `baseline: true`. SARIF results get `baselineState: "unchanged"`
or `"new"`.

The GitHub Action accepts the same file:

```yaml
- uses: sabahattink/codediag@v0
  with:
    threshold: 80
    baseline: .codediag-baseline.json
```

Refresh the baseline with `--update-baseline` after you fix findings, so
fixed problems cannot quietly return.

Project-level findings are identified by their message with numbers masked,
so a test ratio that moves from 25% to 23% stays in the baseline. Vulnerability
totals (`vuln-*`) are the exception: a changed count is a new finding, so new
vulnerabilities fail the gate.
