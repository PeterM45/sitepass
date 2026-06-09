import { createGate, type GateOptions } from './core'
import { gateWebRequest } from './web'

// `Netlify` is a global in the Edge Functions runtime; declared here so the
// adapter typechecks without depending on @netlify/edge-functions.
declare const Netlify: { env: { get(key: string): string | undefined } }

/** The slice of the Netlify Edge Functions context this adapter touches. */
export interface NetlifyContext {
  next: () => Promise<Response>
}

export type NetlifyGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
}

/**
 * Netlify Edge Functions adapter. Like the Cloudflare adapter, it runs on the
 * request before any asset is served, so it gates static sites and SPAs too.
 *
 * Wire it up in netlify/edge-functions/gate.ts:
 *
 *   import { gate, config } from 'sitepass/netlify'
 *   export default gate()
 *   export { config }
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET as environment variables.
 */
export function gate({ maxBodyBytes, ...options }: NetlifyGateOptions = {}) {
  const g = createGate({
    ...options,
    password: netlifyEnv('SITEPASS_PASSWORD'),
    secret: netlifyEnv('SITEPASS_SECRET'),
  })

  return async (request: Request, context: NetlifyContext): Promise<Response> =>
    (await gateWebRequest(g, request, maxBodyBytes)) ?? context.next()
}

// Guarded: outside the Edge runtime (tests, an accidental shared-module import)
// the global is absent; fail closed via the gate's own 503 page instead of
// crashing with a ReferenceError that names no fix.
function netlifyEnv(name: string): string {
  return typeof Netlify === 'undefined' ? '' : (Netlify.env.get(name) ?? '')
}

// Run on every path. Re-export this from your edge function file.
export const config = { path: '/*' }
