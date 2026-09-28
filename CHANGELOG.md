# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-28

### Changed

- **Renamed to readme-generator.** The npm package is `@sm260845/readme-generator`, the main command is `readme-generator` (`readme-gen` still works as an alias), and the repository moved to `SM260845/readme-generator` (old URLs redirect). The `READMEGEN_*` environment variables are unchanged.
- Dependencies: @inquirer/prompts 8, commander 15, eslint 10, vitest 5. `tsc` is now TypeScript 7; typescript-eslint keeps using the TypeScript 6 API.

### Added

- Composite GitHub Action (`uses: SM260845/readme-generator@v0.2.0`) that generates a README, uploads it as an artifact, and writes the summary to the job summary.
- `Action self-test` workflow (manual or on action changes) using the fixture provider.
- Release workflow publishes to npm with provenance when an `NPM_TOKEN` secret is configured.

## [0.1.0] - 2026-09-28

### Added

- `readme-gen` CLI: interactive prompts or flags (`--style`, `--output`, `--force`, `--dry-run`, size limits, timeouts, `--verbose`).
- Four writing styles: professional, trendy, minimalist, comprehensive.
- Read-only GitHub client using the REST API and raw file URLs (no cloning), with timeouts, pagination and actionable errors for malformed URLs, 401/403/404, rate limits (including the reset time) and empty repositories.
- File inventory with limits on file count, total bytes and per-file size. Secrets, binaries, dependency directories, vendored code and build output are never read.
- Secret-pattern scanning and redaction of repository content before generation, and of the generated README.
- Structured project brief: facts, commands and their evidence, unknowns, warnings.
- OpenAI-compatible chat-completions provider (xAI by default) with JSON-schema structured output, plus a deterministic fixture provider.
- Validation: exactly one H1, balanced code fences, no template placeholders, and claim tracing. Untraced commands, links, badges and license statements are listed in a "Verify before publishing" checklist.
- Prebuilt npm tarball attached to each GitHub release (`npm install --global <tarball URL>`).
- Atomic writes. `README.generated.md` is never overwritten without `--force`.

[Unreleased]: https://github.com/SM260845/readme-generator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SM260845/readme-generator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SM260845/readme-generator/releases/tag/v0.1.0
