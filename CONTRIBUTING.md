# Contributing to repo2readme

Thanks for helping. This guide should get you from clone to merged PR quickly.

## Ways to help

- **Try it on a repository you know well** and report what it got wrong. Bad output is the most useful bug report we can get.
- **Request or refine a style.** Use the *Style request* issue template.
- **Pick up an issue** labelled [`good first issue`](https://github.com/SM260845/repo2readme/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/SM260845/repo2readme/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
- **Ask or suggest** in [Discussions](https://github.com/SM260845/repo2readme/discussions).

## Development setup

You need Node.js 22 or newer.

```sh
git clone https://github.com/SM260845/repo2readme.git
cd repo2readme
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

Run the CLI from source without an LLM key. The hidden `--provider fixture` flag uses a deterministic generator; the GitHub calls are real:

```sh
node bin/repo2readme.js https://github.com/sindresorhus/is-plain-obj --style trendy --dry-run --provider fixture --verbose
```

Set `GITHUB_TOKEN` if you hit the anonymous rate limit (60 requests/hour).

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Argument parsing, prompts, orchestration, summary |
| `src/github.ts` | URL validation and the read-only GitHub client |
| `src/inventory.ts` | File classification, exclusions, selection limits |
| `src/brief.ts` | Project brief: facts, commands and their evidence, unknowns |
| `src/generator.ts` | Provider adapter (`generateReadme(brief, style)`), prompts, providers |
| `src/validate.ts` | Rendering, structure checks, secret redaction, claim tracing |
| `src/output.ts` | Overwrite protection, atomic write, summary |
| `src/secrets.ts` | Secret-pattern scanner |
| `src/styles.ts` | Style definitions |
| `test/` | Vitest suites; `test/fixtures/` holds fixture repositories |

## Ground rules

1. **Tests never touch the network.** Inject the mocked `fetch` from `test/helpers.ts`. Build fake secrets at runtime (see `fakeSecrets`) so no credential-shaped string is committed.
2. **The tool stays read-only.** The GitHub client only issues `GET` requests. Any change that writes to GitHub needs an issue and discussion first.
3. **No invented claims.** When you add a detector (a new language or toolchain), commands derived directly from a file get `confidence: 'evidence'`. Conventional commands you infer get `confidence: 'inferred'`, which the validator flags for the user to verify.
4. **Keep the exclusion list conservative.** When in doubt, exclude a file rather than risk sending a secret.

## Adding a style

1. Add the style to `STYLE_IDS` and `STYLES` in `src/styles.ts`. Write a clear `instruction`, since it is sent to the model verbatim.
2. Add a branch to `FixtureProvider` in `src/generator.ts` so the style has deterministic output.
3. Add the style to the CLI tests' `it.each(STYLE_IDS)` coverage (automatic) and update the styles table in `README.md`.

## Adding a provider

Implement `ReadmeProvider` (`generateReadme(brief, style): Promise<GeneratedReadme>`), read configuration from environment variables only, never log keys, and map HTTP errors to `GenerationError` with an actionable hint. Test it with a mocked `fetch`.

## Pull requests

- Keep PRs focused. Add or update tests with every behaviour change.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all pass. CI runs the same checks.
- Update `CHANGELOG.md` under **Unreleased**.
- By contributing, you agree your work is licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
