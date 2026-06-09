import type { Gate } from './core'
import { type AdapterGateOptions, createGateFromEnv, envString, gateWebRequest } from './web'

/**
 * The slice of the Pages Functions context this adapter touches. `env` is typed
 * as `object` rather than a partial record so any consumer-defined `Env` (an
 * interface with KV/D1/etc. bindings, sharing no keys with ours) still satisfies
 * it — a partial record is a TypeScript "weak type" and would reject those,
 * breaking the `export const onRequest: PagesFunction<Env> = gate()` annotation.
 * The env vars are read by name inside `gate`.
 */
export interface PagesContext {
  request: Request
  env: object
  next: () => Promise<Response>
}

interface SitepassEnv {
  SITEPASS_PASSWORD?: unknown
  SITEPASS_SECRET?: unknown
  SITEPASS_BYPASS_TOKEN?: unknown
}

export type CloudflareGateOptions = AdapterGateOptions

/**
 * Cloudflare Pages Functions adapter. This is the universal path: it runs on the
 * HTTP request before any static asset is served, so it gates anything Pages
 * hosts, including pure SPAs and fully static sites.
 *
 * Wire it up in functions/_middleware.ts:
 *
 *   import { gate } from 'sitepass/cloudflare'
 *   export const onRequest = gate()
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the Pages project (and in
 * `.dev.vars` for local `wrangler pages dev`).
 */
export function gate({ maxBodyBytes, ...options }: CloudflareGateOptions = {}) {
  // Bindings only exist at request time, so build the gate on first request and
  // reuse it (and its cached signing key) for the life of the isolate.
  let cached: Gate | undefined
  const gateFor = (rawEnv: object) => {
    // A checked assignment, not an assertion: every SitepassEnv property is
    // optional unknown, so `object` satisfies it and the compiler stays in the loop.
    const env: SitepassEnv = rawEnv
    cached ??= createGateFromEnv(options, (name) => envString(env[name]))
    return cached
  }

  return async (context: PagesContext): Promise<Response> =>
    (await gateWebRequest(gateFor(context.env), context.request, maxBodyBytes)) ?? context.next()
}
