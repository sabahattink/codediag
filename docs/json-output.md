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
| `skipped` | object | Optional. Present only when source files were left out of analysis |

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
`info` and are not penalized. Rule IDs and their
meaning are listed in [rules.md](rules.md).

`fingerprint` is a SHA-256 hex digest that identifies a finding independently
of its line number: it is derived from the rule ID, the file, and the flagged
line's whitespace-normalized text (or the message for findings without a
source line). For rules that flag credentials, such as `hardcoded-secret`,
the line text is never hashed and the message is used instead. Identical
findings in the same file are distinguished by their order. The same value is emitted as the `codediagFinding/v2` SARIF partial
fingerprint.
