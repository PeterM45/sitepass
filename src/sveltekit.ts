import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createGate, type GateOptions } from './core'
import { gateWebRequest } from './web'

export type SvelteKitGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
}

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
  const g = createGate({
    ...options,
    password: env.SITEPASS_PASSWORD ?? '',
    secret: env.SITEPASS_SECRET ?? '',
  })

  return async ({ event, resolve }) =>
    (await gateWebRequest(g, event.request, maxBodyBytes)) ?? resolve(event)
}
