# JSON Output Contract

CodeDiag emits a stable machine-readable result with:

```bash
codediag scan . --format json
```

CI mode uses the same JSON structure and applies the configured quality gate:

```bash
codediag scan . --ci
```

The JSON Schema is available in the repository and the published npm package:

```text
schema/scan-result.schema.json
```

Canonical URL:

```text
https://raw.githubusercontent.com/sabahattink/codediag/main/schema/scan-result.schema.json
```

## Compatibility

- Required properties and enum values are part of the public output contract.
- Optional diagnostic fields may be absent.
- New optional properties require a schema update.
- Removing or renaming properties, changing their types, or narrowing accepted
  values requires a major version.
- Consumers should validate results against the schema version shipped with the
  installed CodeDiag package when reproducibility matters.

## Top-level fields

| Field | Type | Description |
|---|---|---|
| `project` | string | Scanned directory name |
| `stack` | object | Detected framework, language, ORM, and tooling |
| `analyzers` | array | Individual analyzer scores, issues, and summaries |
| `totalScore` | integer | Weighted score from 0 through 100 |
| `grade` | string | `A+`, `A`, `B+`, `B`, `C`, `D`, or `F` |
| `timestamp` | string | UTC ISO 8601 scan timestamp |
| `scoringVersion` | integer | Scoring model used for analyzer scores: `1` or `2` |
| `baseline` | object | Optional. `{ matched, fixed }` when the scan used a baseline |
| `skipped` | object | Optional. Present only when source files were left out of analysis |
| `scope` | object | Optional. Present with `--changed-since`: `{ changedSince, files, excludedFindings }` |
| `comparison` | object | Optional. Present with `--compare`: changes since an earlier report |
| `workspace` | object | Optional. Present with `--workspaces`: `{ tool, packages }` |
| `history` | array | Optional. Present with `--history`: `{ timestamp, totalScore, grade, analyzers }` per recorded scan, oldest first, ending with this scan |

`workspace` describes a combined monorepo report. `tool` is `npm`, `pnpm`,
`yarn`, `lerna`, `nx`, or `turbo`, and `packages` lists each scanned package
as `{ path, name?, framework, totalScore, grade, findings }` (`findings`
counts active findings). In a combined report every finding's `file` is
relative to the workspace root, findings without a file point at their
package's `package.json`, and fingerprints include the package path.

`scope` means the scan reported and scored only findings in the `files`
changed since the `changedSince` Git revision; `excludedFindings` counts the
findings elsewhere, including project-level ones, that were left out.

`comparison` matches findings by `fingerprint` with the report passed to
`--compare`: `previousTimestamp`, `previousScore`, `previousGrade`,
`scoreDelta`, `analyzers` (one `{ name, previous, current, delta }` per
analyzer; `null` when an analyzer did not run in one of the scans),
`newFindings`, `fixedFindings`, and `fixed` (the earlier findings that no
longer occur, as `{ analyzer, rule, severity, message, file?, line? }`). Only
active findings are compared; suppressed and baselined findings are neither
new nor fixed. Each new finding also carries `isNew: true`.

`skipped` counts code files that were not analyzed: `tooLarge` (larger than
`maxFileSizeKb`), `minified` (bundler or minifier output, detected by an
average line length above 500 characters), and `unreadable`. `files` lists up
to 50 of them as `{ "file", "reason" }`, sorted by path.

Each diagnostic issue always includes `severity`, `rule`, and `message`.
Each analyzer result includes `name`, `score`, `issues`, and `summary`. With
scoring version 2 it also includes `scoreBreakdown`: one `{ "rule", "count",
"penalty" }` entry per rule that cost points, sorted by penalty. The penalties
add up to `100 - score` before rounding and the floor at 0.

`file`, `line`, `fix`, `fingerprint`, and `causedBy` are optional. `causedBy`
names the reported rule a finding is a consequence of; such findings are
`info` and are not penalized.

`suppression` (`{ "kind": "inSource", "justification" }`) marks a finding
suppressed by a `codediag-ignore` comment, and `baseline: true` marks a finding
matched by the scan's baseline. Neither kind counts toward scores or
thresholds; see [suppressions and baselines](suppressions-and-baselines.md). Rule IDs and their
meaning are listed in [rules.md](rules.md).

`fingerprint` is a SHA-256 hex digest that identifies a finding independently
of its line number. It is derived from the rule ID, the file, and:

- for findings on a source line, the line's whitespace-normalized text and the
  message (for rules that flag credentials, such as `hardcoded-secret`, only
  the message, so a secret is never hashed);
- for findings on a file without a line, nothing else;
- for project-level findings, the message with numbers masked, except for
  vulnerability totals (`vuln-*`), where a changed count is a new finding.

Identical findings are distinguished by their order. The same value is emitted
as the `codediagFinding/v2` SARIF partial fingerprint.
