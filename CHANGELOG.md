# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-05

Security and hardening release. **Upgrading is recommended for all users**, in
particular anyone using the Express adapter or the `sitepass init` CLI.

### Security

- **Express adapter:** the login request body is now size-capped (default
  64 KiB, configurable via `maxBodyBytes`) and fails closed with `413`. Earlier
  versions read the unauthenticated login `POST` body with no limit, which could
  be used to exhaust process memory. The host edge adapters, the other framework
  adapters, and the reverse proxy were already bounded.
- **CLI:** `sitepass init` now writes the env file that holds `SITEPASS_SECRET`
  with owner-only (`0600`) permissions instead of relying on the default umask
  (commonly world-readable `0644`).
- **Core:** `publicPaths` matching now rejects percent-encoded path separators
  (`%2f` / `%2e`), so an encoded-traversal request can no longer slip gated
  content through a public-prefix match.

### Fixed

- **Express adapter:** the gate derives the request path from `req.originalUrl`,
  so it matches the login path correctly even when mounted on a sub-path.

### Changed

- **CI:** least-privilege `GITHUB_TOKEN` (`contents: read`), GitHub Actions
  pinned to commit SHAs, and a non-blocking `bun audit` step.
- **Dev dependencies:** pinned the `postcss` and `cookie` transitive versions to
  patched releases. These are build-time only — the published package has no
  runtime dependencies, so consumers were never exposed.

## [0.1.0]

Initial release.

[0.1.1]: https://github.com/PeterM45/sitepass/releases/tag/v0.1.1
