# SPA gated at the edge (Vite + React + Cloudflare Pages)

A plain React single-page app with no auth code in it, gated by sitepass through the Cloudflare Pages adapter. This is the proof that an SPA you cannot protect from the inside can still sit behind one password: the gate runs on the request before any file is served.

The entire gate is `functions/_middleware.ts`:

```ts
import { gate } from 'sitepass/cloudflare'
export const onRequest = gate()
```

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then set SITEPASS_PASSWORD and SITEPASS_SECRET
npm run build                    # vite build -> dist/
npm run preview                  # wrangler pages dev (serves the gate + the SPA)
```

Note: `npm run dev` is plain Vite without the Pages Function, so the SPA is served ungated there — use `npm run preview` to exercise the gate.

Open the printed URL. You get the login page first. After you enter the password, the SPA loads and stays available for the session. Visit `/__gate/logout` (or clear the `gate` cookie) to see the gate again.

Generate a secret with `npx sitepass init --target cloudflare` if you want one written for you.

## Running against this repo's local build

This example depends on the published `sitepass`. To test it against the code in this repository, build the package first (`bun run build` at the repo root), then change the `sitepass` dependency here to `"file:../.."` and reinstall.

## Why no client-side guard?

A password check that runs in the browser is not security. The page and its JavaScript are already on the visitor's machine, so a route guard in React is bypassed with devtools. That is why the gate lives in the Pages Function, not in the app.
