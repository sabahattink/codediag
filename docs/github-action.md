# GitHub Action

CodeDiag can run directly as a JavaScript action. The action bundle is stored
in the repository, so consumers do not need to install CodeDiag from npm.

## Basic workflow

```yaml
name: Code health

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  codediag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: sabahattink/codediag@main
        id: codediag
        with:
          threshold: 80

      - name: Show result
        run: |
          echo "Score: ${{ steps.codediag.outputs.score }}"
          echo "Grade: ${{ steps.codediag.outputs.grade }}"
```

Use a full commit SHA instead of `main` when a workflow requires immutable
third-party dependencies. Versioned Action tags will be documented after the
first Action release is cut.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Project directory relative to `GITHUB_WORKSPACE` |
| `threshold` | `70` | Minimum passing score from 0 through 100 |
| `report` | `codediag-report.json` | JSON report path relative to `GITHUB_WORKSPACE` |
| `sarif` | `codediag-report.sarif` | SARIF 2.1.0 report path relative to `GITHUB_WORKSPACE` |

Absolute `path`, `report`, and `sarif` values are also accepted for advanced
workflows. JSON and SARIF paths must resolve to different files. The project
`.codediag.yml` controls analyzer selection and ignore patterns; the Action
input controls the enforced threshold.

## Outputs

| Output | Description |
| --- | --- |
| `score` | Weighted project health score |
| `grade` | Letter grade derived from the score |
| `report` | Absolute path to the JSON report |
| `sarif` | Absolute path to the SARIF report |

The report follows the published
[`scan-result.schema.json`](../schema/scan-result.schema.json) contract.
The SARIF report follows version 2.1.0 and is documented in
[`sarif-output.md`](sarif-output.md).

## Pull request feedback

Every run writes a GitHub job summary containing analyzer scores and actionable
findings. Critical findings become error annotations and warnings become
warning annotations. CodeDiag emits at most 50 annotations per run; the JSON
report retains the complete result.

The action exits with:

- `0` when the score meets the threshold.
- `1` when the score is below the threshold. Outputs and the report are still
  written so later steps using `if: always()` can inspect them.
- `2` when configuration, scanning, or report generation fails.

## Monorepo example

```yaml
- uses: sabahattink/codediag@main
  id: api-health
  with:
    path: apps/api
    threshold: 85
    report: artifacts/api-codediag.json
    sarif: artifacts/api-codediag.sarif
```

## GitHub Code Scanning

Grant `security-events: write`, then upload the `sarif` output with
`github/codeql-action/upload-sarif`. The complete workflow and permission
notes are in the [SARIF output guide](sarif-output.md).

CodeDiag does not require repository write permissions or secrets. The
dependency analyzer invokes the package manager audit command in the selected
project, so the runner must have the matching package manager available.
