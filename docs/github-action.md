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
      - uses: sabahattink/codediag@v0
        id: codediag
        with:
          threshold: 80

      - name: Show result
        run: |
          echo "Score: ${{ steps.codediag.outputs.score }}"
          echo "Grade: ${{ steps.codediag.outputs.grade }}"
```

`@v0` follows the latest 0.x release. Pin an exact release such as
`@v0.4.0`, or a full commit SHA, when a workflow requires immutable
third-party dependencies.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Project directory relative to `GITHUB_WORKSPACE` |
| `threshold` | `70` | Minimum passing score from 0 through 100 |
| `report` | `codediag-report.json` | JSON report path relative to `GITHUB_WORKSPACE` |
| `sarif` | `codediag-report.sarif` | SARIF 2.1.0 report path relative to `GITHUB_WORKSPACE` |
| `baseline` | _(none)_ | Optional CodeDiag JSON report relative to `GITHUB_WORKSPACE`; its findings do not affect the score, threshold, or annotations. See [baselines](suppressions-and-baselines.md#baselines) |
| `comment` | `false` | Post and update one pull request comment; see [pull request comments](#pull-request-comments) |
| `github-token` | `${{ github.token }}` | Token for reading changed files and writing the comment |

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

### Pull request comments

With `comment: true`, CodeDiag keeps one comment on the pull request:

- the score and grade, with ✅ or ❌ for the threshold;
- the change since the previous run (`▲ +3 since the last run`);
- the analyzer table;
- findings in the files the pull request adds or modifies, critical first,
  each linked to its rule documentation;
- a count of findings elsewhere in the project, suppressed findings, and
  baseline findings.

Later pushes update the same comment instead of adding new ones. The job
needs permission to write pull request comments:

```yaml
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  codediag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: sabahattink/codediag@v0
        with:
          threshold: 80
          comment: true
```

Runs outside a pull request skip the comment. If the comment cannot be
written, for example because a pull request from a fork gets a read-only
token, the Action logs a warning and the scan result and threshold still
apply.

The action exits with:

- `0` when the score meets the threshold.
- `1` when the score is below the threshold. Outputs and the report are still
  written so later steps using `if: always()` can inspect them.
- `2` when configuration, scanning, or report generation fails.

## Monorepo example

```yaml
- uses: sabahattink/codediag@v0
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
