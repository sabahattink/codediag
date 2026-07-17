# Review-first fix proposals

CodeDiag converts scan findings into remediation artifacts without changing
the scanned project. The workflow is deliberately review-first: findings must
be validated against the actual source before any patch is approved.

## Fix checklist

```bash
codediag scan . --format fixes > codediag-fixes.md
```

The checklist:

- orders critical findings before warnings and information;
- assigns stable IDs such as `CD-001` within the generated report;
- preserves analyzer, rule, message, file, and line metadata;
- uses analyzer recommendations when available;
- marks findings without a recommendation for investigation;
- leaves every proposal unchecked and review-required.

The output is Markdown so it can be attached to an issue, pull request, or
review record. Generating it does not modify files.

## AI review handoff

```bash
codediag scan . --format prompt > codediag-prompt.txt
```

The prompt contains the same proposal data as JSON plus strict instructions
for a coding agent. It requires the agent to:

1. inspect referenced files before accepting a finding;
2. reject false positives with reasons;
3. propose the smallest maintainable patch and its tests;
4. stop at an approval checkpoint before editing.

Diagnostic values are explicitly identified as untrusted data. CodeDiag does
not include source file contents, upload code, call a model, or apply a patch.
The selected coding agent and its data policy remain the user's responsibility.

## Recommended workflow

1. Generate the checklist and review the highest-severity findings.
2. Generate the prompt only when an AI-assisted review is useful.
3. Give the prompt to a coding agent that can inspect the local repository.
4. Review its validated and rejected findings.
5. Approve a narrowly scoped patch explicitly.
6. Run the project test suite and CodeDiag again after implementation.

The IDs are deterministic for a single scan result, but they are not permanent
issue identifiers across project changes.
