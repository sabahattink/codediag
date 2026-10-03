# SARIF output

CodeDiag can emit [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
for GitHub Code Scanning and other compatible analysis platforms.

```bash
codediag scan . --format sarif > codediag-report.sarif
```

## Mapping

Each CodeDiag issue becomes one SARIF result:

| CodeDiag field | SARIF field |
| --- | --- |
| Analyzer and rule | Stable `ruleId` under `codediag/<analyzer>/<rule>` |
| `critical` | `error` |
| `warning` | `warning` |
| `info` | `note` |
| `file` and `line` | Physical location and start line |
| `fix` | `properties.recommendation` |

Rules shared by multiple findings are emitted once in the tool driver. Rule
metadata comes from the [rule registry](rules.md): `shortDescription` is the
rule title, `fullDescription` and `help` describe the rule, `helpUri` links to
its section in `docs/rules.md`, and security rules carry `security` and
`external/cwe/cwe-<id>` tags plus an `owasp` property.

Each result carries a `codediagFinding/v2` partial fingerprint: a SHA-256
digest of the rule, the file, and the flagged line's whitespace-normalized
text. It does not include the line number, so alerts keep their identity when
code above them moves. Only the digest is emitted, never the line text.
Relative paths remain repository-relative and use forward slashes. Absolute
paths are represented as `file:` URLs. CodeDiag does not include source file
contents or credential values in SARIF output.

## GitHub Code Scanning

The reusable Action writes both JSON and SARIF reports. Upload the SARIF output
in a later step that runs even when the score gate fails:

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v7

  - uses: sabahattink/codediag@main
    id: codediag
    continue-on-error: true
    with:
      threshold: 80
      sarif: artifacts/codediag.sarif

  - name: Upload CodeDiag SARIF
    if: always() && steps.codediag.outputs.sarif != ''
    uses: github/codeql-action/upload-sarif@v4
    with:
      sarif_file: ${{ steps.codediag.outputs.sarif }}

  - name: Enforce CodeDiag score
    if: steps.codediag.outcome == 'failure'
    run: exit 1
```

For untrusted pull requests, follow the repository's Code Scanning permission
policy before granting `security-events: write`.
