# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Express:** middleware failures now go to `next(error)` instead of
  rejecting the middleware promise. Express 4 does not route a rejected
  promise to error handlers, so one unauthenticated client opening a login
  `POST` and dropping the socket mid-body crashed the whole process as an
  unhandled rejection (Express 5 was unaffected). The adapter conformance
  suite now runs against both majors.
- **Reverse proxy:** headers named by the inbound `Connection` header are
  dropped in both directions (RFC 7230 §6.1), so `Connection: x-foo` cannot
  smuggle `x-foo` past the static hop-by-hop list. Defense in depth: no
  working smuggle was demonstrated, since undici re-frames the forwarded
  request.

### Fixed

- **Core:** a fractional `sessionSeconds` (e.g. a value computed by division)
  minted a session token that never validated, so login succeeded and
  immediately bounced back to the login page, forever. The value is now
  floored.
- **Core:** the built-in login page is accessible: the failed-login notice is
  tied to the password input with `aria-describedby`/`aria-invalid` (a
  server-rendered `role="alert"` is never announced), the error and
  input-border colors meet WCAG AA contrast in both color schemes, and the
  page declares `color-scheme` and uses `100dvh` so it renders correctly in
  dark mode and under mobile dynamic toolbars.
- **CLI:** env files are parsed the way dotenv (Next, Astro dev, wrangler)
  parses them — `export ` prefixes, quoted values, and unquoted inline
  comments included — and written values are quoted when needed, so the
  password sitepass writes is the password the framework reads, and `init` no
  longer regenerates a secret or appends a last-wins duplicate when the file
  uses `export` lines.
- **CLI:** stricter argument handling: stray positionals and single-dash
  typos are hard errors, boolean flags reject unrecognized values
  (`--insecure-cookie=yes`), an explicit `--env-file` that does not exist is
  an error instead of silently starting fail-closed, `--origin` must be an
  http(s) URL at startup (previously the proxy started and then 502'd every
  request), `--port 0` reports the OS-assigned port it actually bound, and
  `init` says so when it skips `.gitignore` outside a git root.
- **Netlify:** the published type of `config.path` keeps Netlify's
  `` `/${string}` `` template literal, so `export const config: Config = …`
  typechecks in a Deno-checked edge function.
- **Docs:** the README's `publicPaths` example now actually demonstrates
  segment matching (`/api/webhooks` covers `/api/webhooks/stripe` but not
  `/api/webhooksxyz`), the proxy section spells out that its `maxBodyBytes`
  is the forwarded-body cap (10 MiB default) rather than the adapters'
  64 KiB login cap, the CLI reference documents `--help`/`--version`
  (`-h`/`-v`) and Node's own `--env-file` pre-scan, `.env.example` lists the
  optional `SITEPASS_BYPASS_TOKEN`, and the public types (`GateResult`,
  `Gate`, `ProxyOptions`, the adapter option aliases, the netlify `config`)
  carry hover docs.
- **Examples:** spa-cloudflare depends on `sitepass ^0.2.0` (a `^0.1` range
  never resolves to 0.2.x), pins a wrangler `compatibility_date`, and its
  README warns that plain `vite dev` serves the SPA ungated.

### Added

- **Reverse proxy: `trustProxy` option and `--trust-proxy` flag** for
  deployments behind a TLS terminator: the front hop's `X-Forwarded-*` pass
  through to the origin (the peer is appended to the `For` chain) instead of
  being overwritten with the terminator's loopback address and `proto=http`.
  Off by default — only enable it when clients cannot reach the proxy
  directly.

## [0.2.0] - 2026-06-09

A minor (not patch) release because of the two behavior changes below — `^0.1`
consumers do not pick it up automatically.

Heads-up for upgraders, two deliberate behavior changes:

- **Existing sessions are invalidated once on upgrade.** Tokens now bind a
  digest of the password into the signed message, so visitors log in once more
  with the unchanged password — and from then on, rotating the password
  actually revokes outstanding sessions.
- **Secrets shorter than 16 characters now fail closed** (503 with the
  not-configured page) instead of silently signing tokens with a
  brute-forceable key. Anything written by `sitepass init` is unaffected.

### Security

- **Core:** `publicPaths` matching now rejects literal dot-segments, backslash,
  and path-parameter (`;`) segments, plus their encoded forms (`%2e`, `%2f`,
  `%5c`, `%3b`, and a stray `%25` that a double-decoding origin could unwrap),
  closing the remaining traversal route: the reverse proxy and Express adapters
  pass the raw request target into the gate, so `/assets/../secret` matched an
  `/assets` prefix verbatim while resolving elsewhere at the origin. (The basic
  encoded form was fixed in 0.1.1; the edge adapters were never affected because
  `URL` normalizes the pathname.)
- **Core:** a `publicPaths` entry of `/` is now an exact match on the root
  path. Previously it un-gated the entire site, because trailing-slash
  normalization reduced it to a prefix that matched every path. Empty entries
  are ignored.
- **Core:** rotating `SITEPASS_PASSWORD` now invalidates all outstanding
  sessions (previously only rotating the secret did, and nothing documented
  that).
- **All adapters:** the login `POST` body is read with a 64 KiB cap and fails
  closed with `413` on every adapter (the reverse proxy caps its login body at
  64 KiB too, separately from its larger forward-body limit). Previously only
  Express was capped; Bun and Hono — self-hosted runtimes with no platform
  limit — buffered without bound.
- **Reverse proxy:** the gate's own session cookie and the `x-sitepass-bypass`
  credential are stripped before forwarding, so origin-side logs can no longer
  capture a replayable credential. Other cookies forward unchanged. The
  `X-Forwarded-For`/`-Proto`/`-Host` headers are set authoritatively from the
  proxy-observed connection, so a client cannot spoof them to the origin.

### Fixed

- **Core:** the login `POST` is handled before `publicPaths` matching, so an
  entry covering `loginPath` can no longer make logging in impossible.
- **Cloudflare:** `export const onRequest: PagesFunction<Env> = gate()` now
  typechecks (the env slice no longer demands an index signature), and
  non-string bindings count as unset instead of leaking into the gate.
- **Bun:** the wrapper is generic over the handler's rest arguments, so the
  `(req, server) => server.upgrade(req)` websocket pattern compiles and
  `server` is actually forwarded.
- **Netlify:** importing the adapter outside the Edge runtime fails closed
  (503) instead of throwing `ReferenceError: Netlify is not defined`.
- **CLI:** `--help`/`-h` print usage and exit 0 (previously "Unknown command"
  and exit 1); `sitepass init --help` prints usage instead of starting an
  interactive init; `.env` loading no longer silently does nothing on Node
  20.0–20.11; unknown flags are an error instead of being ignored; a missing
  `SITEPASS_PASSWORD` warns at proxy startup just like a missing secret.
- **Docs:** the README no longer claims the SvelteKit adapter gates static
  output (prerendered pages and `/_app` client assets bypass server hooks),
  documents the Bun adapter's `gate(handler, options)` signature, and corrects
  the localhost/`Secure`-cookie guidance (Chrome and Firefox allow it over
  plain-HTTP localhost; Safari does not).

### Added

- **Bypass token for CI, E2E, and uptime monitors:** set
  `SITEPASS_BYPASS_TOKEN` (or the `bypassToken` option) and send the
  `x-sitepass-bypass` header to pass the gate without a session. Constant-time
  comparison, same as the password check.
- **Logout:** `GET <loginPath>/logout` clears the session cookie and redirects
  to `/`.
- **`renderLoginPage` option** to fully replace the built-in login page
  (localization, logos), plus an exported `escapeHtml` helper for safe
  interpolation.
- **`onAuthFailure` option:** an observer called on every failed login
  attempt, for fail2ban-style logging on platforms without access logs. It
  receives only a redacted `{ method, path }` view — never the submitted
  password or session cookie — so wiring it to logs can't persist credentials.
- **`cookieSecure: false` option** (and the proxy's `--insecure-cookie` flag)
  for plain-HTTP LAN deployments, which previously failed as a silent login
  loop.
- **`maxBodyBytes` option on every adapter** (login body cap; documented now —
  previously Express-only and undocumented).
- **`sitepass/proxy` export:** `startProxy(options)` is now importable for
  programmatic use; it accepts every gate option. (The files already shipped
  in the tarball but were unreachable.)
- **Reverse proxy:** sends authoritative `X-Forwarded-For`/`-Proto`/`-Host` to
  the origin; the CLI exposes gate options as flags (`--public-paths`,
  `--login-path`, `--cookie-name`, `--session-seconds`, `--bypass-token`,
  `--env-file`), with `--session-seconds` validated like `--port`.
- **CLI:** `--version`/`-v`, and `--env-file` for monorepos.
- `"sideEffects": false` for better tree-shaking, and `CHANGELOG.md` now ships
  in the npm tarball.
- **Types:** every adapter exports its options type (`CloudflareGateOptions`,
  …) and context interface; `publicPaths` accepts `readonly string[]`; the
  declarations are precise under `exactOptionalPropertyTypes`;
  `@types/express` is declared as an optional peer dependency; a
  `typesVersions` map resolves subpath types under legacy node10 module
  resolution (TypeScript consumers on `moduleResolution: node` previously got
  no types for `sitepass/cloudflare` et al).
- **CI:** every built `dist` entry is now imported in both formats (plus a CLI
  run and `publint`) before merge and before publish; the publish workflow
  refuses a tag that does not match `package.json`'s version; Dependabot keeps
  the SHA-pinned actions fresh; issue and PR templates.

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

## [0.1.0] - 2026-06-04

Initial release.

[Unreleased]: https://github.com/PeterM45/sitepass/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PeterM45/sitepass/releases/tag/v0.2.0
[0.1.1]: https://github.com/PeterM45/sitepass/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/sitepass/v/0.1.0
