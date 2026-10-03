# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] - 2026-09-28

### Added

- `repo2readme check [README.md]`: an offline, keyless check that a README still matches its repository (npm scripts, file paths, own version/Action tag/tarball, CLI flags vs `--help`, Node.js engine, anchors, Action inputs, `src/` layout). Exits 5 on drift.
- README check workflow (`.github/workflows/readme-check.yml`) runs it against this repository's own README on relevant pushes and pull requests and weekly; README badge and section document it.
- Snapshot tests for the full fixture output of every style (`widget` and `pyapp`), stored as readable Markdown in `test/__snapshots__/`. Refresh them with `npx vitest -u` after an intentional change. Thanks @sivaadithya25 for this contribution (#3, #24).

### Fixed

- README: the `src/` layout now lists `errors.ts` (found by the new check), and the finished snapshot-tests item (#3) is removed from the roadmap.

## [0.3.1] - 2026-09-28

### Fixed

- A generated link with a malformed percent-escape (for example `docs/100%.md`) no longer crashes validation with "Unexpected error"; it is flagged for review instead.
- `REPO2README_BASE_URL=http://[::1]:<port>/v1` is now accepted as localhost, as documented.
- Test fixtures and snapshots (`fixtures/`, `__fixtures__/`, `testdata/`, `__snapshots__/`) are no longer read as if they described the project.
- `--help`: aligned the Environment section.

### Changed

- Docs: npm badge cache fix, README options block matches `--help`, SECURITY supported versions (0.3.x), bug-report version placeholder, spelling consistency.

## [0.3.0] - 2026-09-28

### Added

- Detect Ruby install, Rake task, and gem-install commands from repository manifests.

### Changed

- repo2readme is published to npm: install with `npm i -g repo2readme` (or `npx repo2readme`). The release tarball remains an alternative.

## [0.2.0] - 2026-09-28

### Changed

- npm package and command: `repo2readme`. Environment variables use the `REPO2README_` prefix (`REPO2README_API_KEY`, `REPO2README_BASE_URL`, `REPO2README_MODEL`).
- Dependencies: @inquirer/prompts 8, commander 15, eslint 10, vitest 5. `tsc` is now TypeScript 7; typescript-eslint keeps using the TypeScript 6 API.

### Added

- Composite GitHub Action (`uses: ao3575911/repo2readme@v0.2.0`) that generates a README, uploads it as an artifact, and writes the summary to the job summary.
- `Action self-test` workflow (manual or on action changes) using the fixture provider.
- Release workflow publishes to npm with provenance when an `NPM_TOKEN` secret is configured.

## [0.1.0] - 2026-09-28

### Added

- `repo2readme` CLI: interactive prompts or flags (`--style`, `--output`, `--force`, `--dry-run`, size limits, timeouts, `--verbose`).
- Four writing styles: professional, trendy, minimalist, comprehensive.
- Read-only GitHub client using the REST API and raw file URLs (no cloning), with timeouts, pagination and actionable errors for malformed URLs, 401/403/404, rate limits (including the reset time) and empty repositories.
- File inventory with limits on file count, total bytes and per-file size. Secrets, binaries, dependency directories, vendored code and build output are never read.
- Secret-pattern scanning and redaction of repository content before generation, and of the generated README.
- Structured project brief: facts, commands and their evidence, unknowns, warnings.
- OpenAI-compatible chat-completions provider (xAI by default) with JSON-schema structured output, plus a deterministic fixture provider.
- Validation: exactly one H1, balanced code fences, no template placeholders, and claim tracing. Untraced commands, links, badges and license statements are listed in a "Verify before publishing" checklist.
- Prebuilt npm tarball attached to each GitHub release (`npm install --global <tarball URL>`).
- Atomic writes. `README.generated.md` is never overwritten without `--force`.

[Unreleased]: https://github.com/ao3575911/repo2readme/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/ao3575911/repo2readme/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ao3575911/repo2readme/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ao3575911/repo2readme/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ao3575911/repo2readme/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ao3575911/repo2readme/releases/tag/v0.1.0
