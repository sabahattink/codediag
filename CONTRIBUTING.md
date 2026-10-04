# Contributing to CodeDiag

CodeDiag welcomes focused bug fixes, analyzer improvements, tests, and
documentation updates. Before starting a large feature, open an issue so the
scope and expected behavior can be agreed on first.

## Development setup

Requirements:

- Node.js 20.19 or newer (CI runs 20, 22, and 24)
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
Every finding uses a rule registered in `src/rules/registry.ts` through
`fromRule()`. After adding or changing a rule, run `npm run docs:rules` to
regenerate `docs/rules.md`; the test suite fails when it is stale.

`tests/fixtures/realistic/` holds small, well-built NestJS, Express, and
Next.js applications that must keep scoring at least 85 with no critical
findings, and `tests/fixtures/defects/` holds applications that must keep
producing specific findings (`tests/benchmark.test.ts`). When an analyzer
change fails these tests, fix the analyzer rather than the fixture unless the
fixture itself is wrong. The fixtures are excluded from Biome and from
CodeDiag's own scan (`.codediag.yml`).
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

## Releasing

1. Move the `[Unreleased]` changelog entries under a new version heading and
   set `version` in `package.json` (and `extensions/vscode/package.json` when
   the extension changes) with `npm version <x.y.z> --no-git-tag-version`.
2. Run `npm run check` and merge to `main`.
3. Publish a GitHub release tagged `v<x.y.z>`. The Release workflow checks
   that the tag matches `package.json`, runs `npm run check`, publishes to npm
   with provenance through npm trusted publishing, and attaches the VS Code
   `.vsix` to the release. No npm token is stored in the repository: the
   package's trusted publisher on npmjs.com (GitHub Actions,
   `sabahattink/codediag`, workflow `release.yml`, "Allow npm publish") lets
   this workflow publish with a short-lived OIDC credential.
4. Move the Action's major tag (for example `v0`) to the release commit so
   `uses: sabahattink/codediag@v0` picks it up.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
