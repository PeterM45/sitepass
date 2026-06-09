# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Core:** `publicPaths` matching now rejects literal dot-segments and
  backslash segments, closing the remaining traversal route: the reverse proxy
  and Express adapters pass the raw request target into the gate, so
  `/assets/../secret` matched an `/assets` prefix verbatim while resolving
  elsewhere at the origin. (The percent-encoded form was fixed in 0.1.1; the
  edge adapters were never affected because `URL` normalizes the pathname.)
- **Core:** a `publicPaths` entry of `/` is now an exact match on the root
  path. Previously it un-gated the entire site, because trailing-slash
  normalization reduced it to a prefix that matched every path. Empty entries
  are ignored.

### Fixed

- **Core:** the login `POST` is handled before `publicPaths` matching, so an
  entry covering `loginPath` can no longer make logging in impossible.
- **Docs:** the README no longer claims the SvelteKit adapter gates static
  output (prerendered pages and `/_app` client assets bypass server hooks),
  and documents the Bun adapter's `gate(handler, options)` signature.

### Added

- **`sitepass/proxy` export:** `startProxy(options)` is now importable for
  programmatic use; it accepts every gate option. (The files already shipped
  in the tarball but were unreachable.)
- `"sideEffects": false` for better tree-shaking, and `CHANGELOG.md` now ships
  in the npm tarball.
- **CI:** every built `dist` entry is now imported in both formats (plus a CLI
  run and `publint`) before merge and before publish, and the publish workflow
  refuses a tag that does not match `package.json`'s version.

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
