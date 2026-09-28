# Security policy

## Supported versions

Security fixes go into the latest release only.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's [private vulnerability reporting](https://github.com/SM260845/repo2readme/security/advisories/new).

Please include the repo2readme version, the command you ran (redact tokens), what happened and what you expected. We aim to acknowledge reports within 7 days.

## What counts

repo2readme handles two sensitive things: your credentials (`GITHUB_TOKEN`, the generation API key) and the repository content it sends to your chosen generation provider. We especially want to hear about:

- a credential appearing in output, logs, error messages or requests to the wrong host
- a file that should be excluded (secrets, `.env`, keys) being read or sent to the provider
- a secret pattern the scanner misses in content sent to the provider or written to the README
- any code path that writes to GitHub (the tool is designed to be strictly read-only)
- prompt injection from repository content that bypasses claim validation

## Design notes

- Tokens are read only from environment variables and sent only to their own host.
- The GitHub client issues only `GET` requests.
- Files matching secret, binary, dependency and vendored patterns are never fetched. Fetched content is scanned for secret patterns and redacted before it reaches the generator, and the generated README is scanned again before it is written.
