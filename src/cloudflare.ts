import { createGate, type Gate, type GateOptions } from './core'
import { envString, gateWebRequest } from './web'

/**
 * The slice of the Pages Functions context this adapter touches. `env` is typed
 * as `object` rather than a partial record so any consumer-defined `Env` (an
 * interface with KV/D1/etc. bindings, sharing no keys with ours) still satisfies
 * it — a partial record is a TypeScript "weak type" and would reject those,
 * breaking the `export const onRequest: PagesFunction<Env> = gate()` annotation.
 * The two env vars are read by name via a cast inside `gate`.
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

export type CloudflareGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number | undefined
}

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
    const env = rawEnv as SitepassEnv
    cached ??= createGate({
      ...options,
      password: envString(env.SITEPASS_PASSWORD),
      secret: envString(env.SITEPASS_SECRET),
      bypassToken: options.bypassToken ?? (envString(env.SITEPASS_BYPASS_TOKEN) || undefined),
    })
    return cached
  }

  return async (context: PagesContext): Promise<Response> =>
    (await gateWebRequest(gateFor(context.env), context.request, maxBodyBytes)) ?? context.next()
}
