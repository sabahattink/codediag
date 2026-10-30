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
`@v0.8.0`, or a full commit SHA, when a workflow requires immutable
third-party dependencies.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Project directory relative to `GITHUB_WORKSPACE` |
| `threshold` | `70` | Minimum passing score from 0 through 100 |
| `fail-on` | _(config)_ | Fail on any active finding at or above `critical`, `warning`, or `info`, whatever the score; overrides `failOn` in `.codediag.yml` |
| `report` | `codediag-report.json` | JSON report path relative to `GITHUB_WORKSPACE` |
| `sarif` | `codediag-report.sarif` | SARIF 2.1.0 report path relative to `GITHUB_WORKSPACE` |
| `baseline` | _(none)_ | Optional CodeDiag JSON report relative to `GITHUB_WORKSPACE`; its findings do not affect the score, threshold, or annotations. See [baselines](suppressions-and-baselines.md#baselines) |
| `compare` | _(none)_ | Optional JSON report of the base branch relative to `GITHUB_WORKSPACE`; the comment and job summary show the score change against it and which findings are new or fixed. See [comparing with the base branch](#comparing-with-the-base-branch) |
| `workspaces` | `false` | Scan every workspace package below `path` (npm, pnpm, Yarn, Lerna, Nx) and combine the reports; see [monorepos](../README.md#monorepos) |
| `package-threshold` | _(config)_ | With `workspaces: true`, the minimum score of every package; overrides `packageThreshold` in `.codediag.yml` |
| `secret-history` | _(config)_ | Also report secrets that recent commits added and the current tree no longer has: `true` reads the last 1000 commits, a number sets the limit, `false` turns off `secretHistory` from `.codediag.yml`. Needs `fetch-depth: 0`; see [secrets in Git history](#secrets-in-git-history) |
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

### Comparing with the base branch

By default the comment shows the change since the previous push. To compare
with the base branch instead, give the Action a report of the base branch,
for example one uploaded by the workflow that runs on `main`:

```yaml
# On pushes to main
- uses: sabahattink/codediag@v0
  with:
    report: codediag-main.json
- uses: actions/upload-artifact@v4
  with:
    name: codediag-main
    path: codediag-main.json

# On pull requests
- uses: dawidd6/action-download-artifact@v6
  with:
    branch: main
    name: codediag-main
- uses: sabahattink/codediag@v0
  with:
    comment: true
    compare: codediag-main.json
```

The comment then reads, for example, `▼ −3 vs. the base branch (81) · 1 new ·
2 fixed`, and marks new findings in changed files as **new**. The job summary
and the JSON report carry the same comparison.

## Monorepo example

Scan every workspace package and combine the reports:

```yaml
- uses: sabahattink/codediag@v0
  with:
    workspaces: true
    threshold: 80
    package-threshold: 70
```

With `package-threshold`, a package that scores below it fails the job on its
own, with an error annotation naming the package, even when the combined
score passes.

Or scan one package with its own threshold and reports:

```yaml
- uses: sabahattink/codediag@v0
  id: api-health
  with:
    path: apps/api
    threshold: 85
    report: artifacts/api-codediag.json
    sarif: artifacts/api-codediag.sarif
```

## Secrets in Git history

A credential that was committed and later deleted is still in every clone.
With `secret-history`, the Action also reads the added lines of recent
commits and reports such secrets as `secret-in-git-history`. It needs the
history, so check out the full repository; the default `fetch-depth: 1`
checkout contains only the newest commit, and the Action warns that the
history it read is partial:

```yaml
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: sabahattink/codediag@v0
    with:
      threshold: 80
      secret-history: true   # or a number of commits, such as 5000
```

Only the checked-out branch is read (`HEAD`, not every ref), and secrets
that are still in the current tree are left to `hardcoded-secret` and
`committed-env-secret`. Findings name the kind of secret, the file, and the
commit; never the value. See
[security analysis](security-analysis.md#secrets-in-git-history).

## GitHub Code Scanning

Grant `security-events: write`, then upload the `sarif` output with
`github/codeql-action/upload-sarif`. The complete workflow and permission
notes are in the [SARIF output guide](sarif-output.md).

CodeDiag does not require repository write permissions or secrets. The
dependency analyzer invokes the package manager audit command in the selected
project, so the runner must have the matching package manager available.
