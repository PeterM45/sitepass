import { createGate, type Gate, type GateOptions } from './core'
import { envString, gateWebRequest } from './web'

/**
 * The slice of the Pages Functions context this adapter touches. The env
 * fields are typed as optional `unknown` (not an index signature) so any
 * consumer-defined `Env` interface — including ones with KV/D1 bindings —
 * satisfies it when annotating `onRequest` with `PagesFunction<Env>`.
 */
export interface PagesContext {
  request: Request
  env: { SITEPASS_PASSWORD?: unknown; SITEPASS_SECRET?: unknown }
  next: () => Promise<Response>
}

export type CloudflareGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
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
  const gateFor = (env: PagesContext['env']) => {
    cached ??= createGate({
      ...options,
      password: envString(env.SITEPASS_PASSWORD),
      secret: envString(env.SITEPASS_SECRET),
    })
    return cached
  }

  return async (context: PagesContext): Promise<Response> =>
    (await gateWebRequest(gateFor(context.env), context.request, maxBodyBytes)) ?? context.next()
}
