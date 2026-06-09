import type { MiddlewareHandler } from 'astro'
import { createGate, type GateOptions } from './core'
import { gateWebRequest } from './web'

export type AstroGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number | undefined
}

/**
 * Astro middleware adapter.
 *
 * This only enforces on routes rendered on demand. A fully prerendered (static)
 * Astro site runs middleware at build time, not per request, so the gate cannot
 * protect it. For static Astro use the Cloudflare or Netlify adapter, or set
 * `export const prerender = false` (with an adapter installed) on the routes you
 * want gated.
 *
 * Wire it up in src/middleware.ts:
 *
 *   import { gate } from 'sitepass/astro'
 *   export const onRequest = gate()
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment.
 */
export function gate({ maxBodyBytes, ...options }: AstroGateOptions = {}): MiddlewareHandler {
  const g = createGate({
    ...options,
    password: readEnv('SITEPASS_PASSWORD'),
    secret: readEnv('SITEPASS_SECRET'),
    bypassToken: options.bypassToken ?? (readEnv('SITEPASS_BYPASS_TOKEN') || undefined),
  })

  return async (context, next) => (await gateWebRequest(g, context.request, maxBodyBytes)) ?? next()
}

// Prefer Vite's import.meta.env (when sitepass is bundled into the SSR output),
// fall back to process.env (the common case, where it runs under adapter-node).
// Both are guarded so neither reference throws in any runtime.
function readEnv(name: string): string {
  const viteEnv =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : undefined
  const fromProcess = typeof process !== 'undefined' ? process.env[name] : undefined
  return viteEnv?.[name] ?? fromProcess ?? ''
}
