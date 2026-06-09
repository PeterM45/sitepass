# sitepass

[![CI](https://github.com/PeterM45/sitepass/actions/workflows/ci.yml/badge.svg)](https://github.com/PeterM45/sitepass/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sitepass)](https://www.npmjs.com/package/sitepass)
[![license](https://img.shields.io/npm/l/sitepass)](./LICENSE)

Put one shared password in front of any web app. No database, no user accounts, no auth provider.

## The problem

You build a client preview, a staging site, or a marketing page, and you want one password in front of it. Not real accounts. Not SSO. Just "type the password to come in."

On Vercel the built-in answer is Advanced Deployment Protection, which runs about $150/month and comes with a 30-day minimum commitment. That is a lot of money and lock-in for a single password.

sitepass is that single password. It is a small framework-agnostic core plus thin adapters, with zero runtime dependencies, and it runs on edge runtimes, Cloudflare Workers, Deno, Bun, and Node 20+.

## How it works

A password gate is only real if the check runs on a server, before the protected bytes leave the building. So sitepass gives you two ways to install it:

- **Host edge adapters** (Cloudflare Pages, Netlify Edge, and a standalone reverse proxy). These run on the HTTP request before a file is served, so they gate any output, including pure SPAs and fully static sites.
- **Framework server adapters** (Next, Astro, SvelteKit, Express, Hono, Bun) for nicer ergonomics where the framework already has a server hook.

When a visitor has no valid session, they get a self-contained login page. They submit the password, the server checks it, and on success it sets a signed, HttpOnly cookie and redirects them back to where they were headed. The cookie is a stateless HMAC token, so there is no session store to run.

## Install

```sh
npm install sitepass
# or: pnpm add sitepass / bun add sitepass
```

Then generate a secret and get the snippet for your target:

```sh
npx sitepass init
```

`init` writes the right env file (`.env`, or `.dev.vars` for Cloudflare), generates `SITEPASS_SECRET`, and prints the wiring for the target you pick. Re-running it never overwrites an existing secret.

You always set two environment variables:

- `SITEPASS_PASSWORD` is the shared password visitors type.
- `SITEPASS_SECRET` is a random 32+ byte string that signs session cookies. Keep it private. Secrets shorter than 16 characters are treated as unconfigured and the gate fails closed.

## Quickstart

### Cloudflare Pages (works for any static site or SPA)

Create `functions/_middleware.ts`:

```ts
import { gate } from 'sitepass/cloudflare'

export const onRequest = gate()
```

Set `SITEPASS_PASSWORD` and `SITEPASS_SECRET` in your Pages project (and in `.dev.vars` for `wrangler pages dev`). That is the whole setup. Every route is now gated before any asset is served.

### Netlify Edge (also gates static output)

Create `netlify/edge-functions/gate.ts`:

```ts
import { gate, config } from 'sitepass/netlify'

export default gate()
export { config }
```

The `config` re-export routes the edge function to every path — without it the function never runs and nothing is gated. Set the two environment variables in your Netlify site settings.

### Next.js middleware

Create `middleware.ts` (Next 15 and earlier) or `proxy.ts` (Next 16+):

```ts
import { gate } from 'sitepass/next'

export const middleware = gate() // Next 16+: export const proxy = gate()

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

## Can this protect my Angular / React / Vue SPA?

Not from inside the app. A password check that runs in the browser is not security: the page and its JavaScript are already on the visitor's machine, and a client-side guard is bypassed with devtools. Use the Cloudflare Pages or Netlify Edge adapter, which gates the request before any file is served. Same answer for a fully static Astro site.

sitepass deliberately ships no React, Angular, or Vue component that hides content in the browser, because that would be obfuscation dressed up as protection.

## Targets

| Target | Import | Where it runs | Gates static output |
| --- | --- | --- | --- |
| Cloudflare Pages | `sitepass/cloudflare` | `functions/_middleware.ts` | Yes |
| Netlify Edge | `sitepass/netlify` | `netlify/edge-functions/gate.ts` | Yes |
| Reverse proxy | `sitepass proxy` | standalone Node/Bun server | Yes |
| Next.js >= 13 | `sitepass/next` | `middleware.ts` / `proxy.ts` | App routes (see matcher note) |
| Astro >= 4 | `sitepass/astro` | `src/middleware.ts` | On-demand routes only |
| SvelteKit >= 2 | `sitepass/sveltekit` | `src/hooks.server.ts` | SSR routes only |
| Express >= 4 | `sitepass/express` | `app.use(gate())` | Yes |
| Hono >= 4 | `sitepass/hono` | `app.use(gate())` | Yes |
| Bun | `sitepass/bun` | `Bun.serve({ fetch: gate(handler) })` | Yes |

Every adapter is a factory: call `gate(options)` and wire the result into the host's request hook. The host edge adapters and the reverse proxy are the ones that gate a pure SPA or a fully static site, because they run before a file is served.

### Reverse proxy

For a self-hosted static site with no edge layer, run the gate as a proxy in front of your origin:

```sh
sitepass proxy --origin http://localhost:8080 --port 8788
```

It reads `SITEPASS_PASSWORD` and `SITEPASS_SECRET` from the environment (and `.env` if present), gates each request, and streams the origin response back on success. The origin receives `X-Forwarded-For`/`-Proto`/`-Host`, and the gate's own session cookie is stripped before forwarding. Gate options are available as flags — see the CLI reference below. Forwarded request bodies are buffered with a 10 MiB cap (`maxBodyBytes`), so uploads larger than that will not pass; WebSocket upgrades are not supported.

The proxy is also importable for custom setups, and accepts every gate option from the Configuration section:

```ts
import { startProxy } from 'sitepass/proxy'

startProxy({
  origin: 'http://localhost:8080',
  port: 8788,
  password: process.env.SITEPASS_PASSWORD ?? '',
  secret: process.env.SITEPASS_SECRET ?? '',
  publicPaths: ['/health'],
})
```

## Configuration

Pass options to any adapter's `gate()`:

```ts
gate({
  cookieName: 'gate', // session cookie name
  sessionSeconds: 60 * 60 * 24 * 7, // session length (default 7 days)
  loginPath: '/__gate', // path that accepts the login POST
  publicPaths: ['/health', '/api/webhooks'], // bypass the gate (exact or path-prefix)
  failOpen: false, // if password/secret are unset: false = 503, true = let traffic through
  bypassToken: undefined, // see "Letting robots through" below
  cookieSecure: true, // set false only for plain-HTTP (LAN) deployments
  maxBodyBytes: 64 * 1024, // login POST body cap before responding 413
  onAuthFailure: (request) => {}, // observer for failed login attempts
  renderLoginPage: undefined, // replace the built-in login page (see below)
  brand: {
    title: 'Protected',
    subtitle: 'Enter the password to continue.',
    accent: '#4f46e5',
  },
})
```

`password` and `secret` are not options on the adapters. Every adapter reads them from the environment so they never end up in your source. (The core API, `createGate`, takes them directly — see below.) `publicPaths` matches whole path segments, so `/api/webhooks` covers `/api/webhooks/stripe` but not `/apixyz`; `/` is an exact match for the root path only.

The Bun adapter is the one exception to the factory shape: the handler comes first — `gate(myHandler, options)`.

The Next.js matcher is a tradeoff. Excluding `_next/static` keeps middleware invocations (and cost) down, but the raw JS chunks under that path are then reachable without the password. The actual page content lives in the gated HTML and RSC payload, so the protected text and data stay behind the gate; the build artifacts do not.

### Letting robots through (CI, E2E, uptime monitors)

Set `SITEPASS_BYPASS_TOKEN` in the environment (or pass `bypassToken` to `gate()`), then send it as a header — no login form scripting needed:

```sh
curl -H "x-sitepass-bypass: $SITEPASS_BYPASS_TOKEN" https://staging.example.com/health
```

The comparison is constant-time, like the password check. Treat the token like a password: long, random, rotated when people leave.

### Logging out

`GET <loginPath>/logout` (default `/__gate/logout`) clears the session cookie and redirects to `/`, which shows the login page again. Handy when testing the gate or leaving a shared machine.

### Custom login page

`renderLoginPage` replaces the built-in page entirely — for localization, a logo, or matching your product:

```ts
import { escapeHtml } from 'sitepass'

gate({
  renderLoginPage: ({ loginPath, next, error, brand }) => `<!doctype html>
    <h1>${brand.title}</h1>
    ${error ? '<p>Mot de passe incorrect.</p>' : ''}
    <form method="post" action="${loginPath}">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <input name="password" type="password" autofocus required />
      <button>Entrer</button>
    </form>`,
})
```

The form must POST to `loginPath` with a `password` input and the hidden `next` input, and you must HTML-escape `next` when interpolating it.

### Watching failed logins

`onAuthFailure` fires on every wrong-password attempt — wire it to your logging or alerting (a `POST <loginPath>` returning 401 in your access logs is the same signal, ready for fail2ban). It receives only a redacted `{ method, path }` view, never the submitted password or the session cookie, so logging it can't persist credentials:

```ts
gate({ onAuthFailure: ({ path }) => console.warn(`sitepass: failed login at ${path}`) })
```

## CLI reference

```text
sitepass init  [--target <name>] [--password <pw>] [--env-file <path>]
sitepass proxy --origin <url> [--port <n>] [--env-file <path>]
               [--public-paths <a,b>] [--login-path <path>]
               [--cookie-name <name>] [--session-seconds <n>]
               [--bypass-token <token>] [--insecure-cookie]
```

`init` is interactive in a terminal; in scripts and CI, pass `--target` (one of `cloudflare`, `netlify`, `next`, `astro`, `sveltekit`, `express`, `hono`, `bun`). `--env-file` redirects where `init` writes and where `proxy` reads. `--insecure-cookie` drops the cookie's `Secure` attribute for plain-HTTP LAN origins — without it, browsers reject the cookie and login loops. Unknown flags are an error, never silently ignored.

## Core API (custom adapters)

The root export is the framework-agnostic core. If your host is not covered by a shipped adapter, the whole contract is one function:

```ts
import { createGate, readCookie } from 'sitepass'

const gate = createGate({
  password: process.env.SITEPASS_PASSWORD ?? '',
  secret: process.env.SITEPASS_SECRET ?? '',
})

// For each request, normalize → handle → translate:
const result = await gate.handle({
  method: request.method,
  path: url.pathname,
  search: url.search,
  cookie: readCookie(request.headers.get('cookie'), gate.cookieName),
  bypassToken: request.headers.get('x-sitepass-bypass') ?? undefined,
  body: isLoginPost ? await request.text() : undefined,
})
// result is { type: 'pass' } | { type: 'redirect', location, setCookie }
//          | { type: 'html', status, body, headers }
```

See CONTRIBUTING.md for the full adapter contract.

## Security model

- The session token is `base64url(expiry) "." base64url(HMAC-SHA256(expiry "." passwordTag, secret))`. Verification recomputes the HMAC and compares it in constant time, then checks the expiry. There is no server-side session store.
- A digest of the password is part of the signed message, so **rotating either the password or the secret invalidates every outstanding session**.
- The password check HMACs both the submitted and configured passwords and compares the two fixed-length digests in constant time, so it does not leak length or content through timing.
- The cookie is `HttpOnly`, `Secure` (unless `cookieSecure: false`), `SameSite=Lax`, `Path=/`.
- A missing password, a missing secret, or a secret shorter than 16 characters fails closed (HTTP 503) by default. `failOpen: true` opts out.
- The `next` redirect target is validated to a same-site absolute path, so the login form cannot bounce a visitor to another origin.
- The core uses only Web Crypto and other platform globals. No Node-only APIs, no dependencies.

## Limitations

- A shared-password gate is brute-forceable, and there is no built-in rate limiting because there is no datastore. Use a long passphrase, and use `onAuthFailure` or your access logs (`POST /__gate` → 401) to alert or ban.
- It is one password for everyone. There are no per-user accounts, roles, or audit logs. If you need those, you want a real auth provider.
- The Astro adapter only enforces on routes rendered on demand. A fully static Astro build runs middleware at build time, not per request, so use the Cloudflare or Netlify adapter for static Astro (or set `export const prerender = false` with an adapter).
- The SvelteKit adapter has the same boundary: `handle` only runs for server-rendered requests, so prerendered pages and the client assets under `/_app` are served without the gate. For a fully prerendered SvelteKit site, use the Cloudflare or Netlify adapter.
- The cookie's `Secure` attribute requires HTTPS — except on `localhost`, where Chrome and Firefox accept it over plain HTTP (Safari does not; use `wrangler pages dev --local-protocol=https`, a tunnel, or test in another browser). For a plain-HTTP LAN deployment behind the reverse proxy, use `--insecure-cookie` deliberately.
- The reverse proxy buffers forwarded request bodies (10 MiB cap by default) and does not tunnel WebSocket upgrades.

## License

MIT
