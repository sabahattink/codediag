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
| `skipped` | object | Optional. Present only when source files were left out of analysis |

`skipped` counts code files that were not analyzed: `tooLarge` (larger than
`maxFileSizeKb`), `minified` (bundler or minifier output, detected by an
average line length above 500 characters), and `unreadable`. `files` lists up
to 50 of them as `{ "file", "reason" }`, sorted by path.

Each diagnostic issue always includes `severity`, `rule`, and `message`.
`file`, `line`, and `fix` are optional.
