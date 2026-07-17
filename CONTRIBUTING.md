# Contributing to CodeDiag

CodeDiag welcomes focused bug fixes, analyzer improvements, tests, and
documentation updates. Before starting a large feature, open an issue so the
scope and expected behavior can be agreed on first.

## Development setup

Requirements:

- Node.js 18 or newer
- npm 9 or newer

```bash
git clone https://github.com/sabahattink/codediag.git
cd codediag
npm ci
npm run check
```

Run the built CLI against a local project:

```bash
node dist/index.js scan /path/to/project
```

## Making a change

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Keep analyzer findings deterministic and actionable.
4. Run `npm run check` before opening a pull request.
5. Update `CHANGELOG.md` when the change affects users.

Analyzer changes should include fixtures for both positive and negative cases.
Avoid checks that depend on network access unless the analyzer already owns
that dependency and the failure mode is covered by tests.

## Commit and pull request style

Use a short conventional commit subject where practical:

- `feat:` for user-facing functionality
- `fix:` for behavior corrections
- `docs:` for documentation-only changes
- `test:` for test-only changes
- `chore:` for maintenance

Pull requests should explain the problem, the chosen behavior, and the
verification performed. Keep unrelated refactors in separate pull requests.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
