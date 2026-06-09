import type { MiddlewareHandler } from 'astro'
import { type AdapterGateOptions, createGateFromEnv, gateWebRequest } from './web'

/** Options for `gate`: every gate option except the env-sourced credentials, plus `maxBodyBytes`. */
export type AstroGateOptions = AdapterGateOptions

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
  const g = createGateFromEnv(options, readEnv)

  return async (context, next) => (await gateWebRequest(g, context.request, maxBodyBytes)) ?? next()
}

// Prefer Vite's import.meta.env (when sitepass is bundled into the SSR output),
// fall back to process.env (the common case, where it runs under adapter-node).
// The env read is optional-chained, not guarded with `typeof import.meta`:
// every ESM runtime defines import.meta, so the read can't throw there, while
// a bare import.meta reference makes the CJS build polyfill it with a
// require('url') shim that runs on every call and throws if a consumer
// re-bundles that file for an ESM/edge target. Without it the CJS build
// compiles the read to a plain undefined: only process.env applies, the one
// behavior a CJS artifact can have (Vite consumers are always ESM).
function readEnv(name: string): string {
  const fromProcess = typeof process !== 'undefined' ? process.env[name] : undefined
  return import.meta.env?.[name] ?? fromProcess ?? ''
}
