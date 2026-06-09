import { type AdapterGateOptions, createGateFromEnv, gateWebRequest } from './web'

// `Netlify` is a global in the Edge Functions runtime; declared here so the
// adapter typechecks without depending on @netlify/edge-functions.
declare const Netlify: { env: { get(key: string): string | undefined } }

/** The slice of the Netlify Edge Functions context this adapter touches. */
export interface NetlifyContext {
  next: () => Promise<Response>
}

export type NetlifyGateOptions = AdapterGateOptions

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
  const g = createGateFromEnv(options, netlifyEnv)

  return async (request: Request, context: NetlifyContext): Promise<Response> =>
    (await gateWebRequest(g, request, maxBodyBytes)) ?? context.next()
}

// Guarded: outside the Edge runtime (tests, an accidental shared-module import)
// the global is absent; fail closed via the gate's own 503 page instead of
// crashing with a ReferenceError that names no fix.
function netlifyEnv(name: string): string {
  return typeof Netlify === 'undefined' ? '' : (Netlify.env.get(name) ?? '')
}

// Run on every path. Re-export this from your edge function file. Annotated so
// the leading-slash literal survives into the published types: Netlify's own
// Config types `path` as a `/${string}` template, and a plain `string` would
// fail an `export const config: Config = …` annotation in a consumer project.
export const config: { path: `/${string}` } = { path: '/*' }
