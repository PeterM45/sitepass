import type { MiddlewareHandler } from 'astro'
import { createGate, type GateOptions } from './core'

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
export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}): MiddlewareHandler {
  const g = createGate({
    ...options,
    password: readEnv('SITEPASS_PASSWORD'),
    secret: readEnv('SITEPASS_SECRET'),
  })

  return async (context, next) => {
    const { request, url } = context
    const isLoginPost = request.method.toUpperCase() === 'POST' && url.pathname === g.loginPath

    const result = await g.handle({
      method: request.method,
      path: url.pathname,
      search: url.search,
      cookie: context.cookies.get(g.cookieName)?.value,
      body: isLoginPost ? await request.text() : undefined,
    })

    switch (result.type) {
      case 'pass':
        return next()
      case 'redirect':
        return new Response(null, {
          status: 302,
          headers: { Location: result.location, 'Set-Cookie': result.setCookie },
        })
      case 'html':
        return new Response(result.body, { status: result.status, headers: result.headers })
    }
  }
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
