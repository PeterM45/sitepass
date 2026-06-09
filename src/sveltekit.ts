import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { type AdapterGateOptions, createGateFromEnv, gateWebRequest } from './web'

export type SvelteKitGateOptions = AdapterGateOptions

/**
 * SvelteKit server hook adapter. It only runs for server-rendered requests:
 * prerendered pages and the client assets under /_app bypass server hooks, so
 * use the Cloudflare or Netlify adapter for a fully prerendered site.
 *
 * Wire it up in src/hooks.server.ts:
 *
 *   import { gate } from 'sitepass/sveltekit'
 *   export const handle = gate()
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment (read at runtime
 * via $env/dynamic/private, which maps to process.env under adapter-node).
 */
export function gate({ maxBodyBytes, ...options }: SvelteKitGateOptions = {}): Handle {
  const g = createGateFromEnv(options, (name) => env[name] ?? '')

  return async ({ event, resolve }) =>
    (await gateWebRequest(g, event.request, maxBodyBytes)) ?? resolve(event)
}
