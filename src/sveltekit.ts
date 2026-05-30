import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createGate, type GateOptions } from './core'

/**
 * SvelteKit server hook adapter.
 *
 * Wire it up in src/hooks.server.ts:
 *
 *   import { gate } from 'sitepass/sveltekit'
 *   export const handle = gate()
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment (read at runtime
 * via $env/dynamic/private, which maps to process.env under adapter-node).
 */
export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}): Handle {
  const g = createGate({
    ...options,
    password: env.SITEPASS_PASSWORD ?? '',
    secret: env.SITEPASS_SECRET ?? '',
  })

  return async ({ event, resolve }) => {
    const { request, url } = event
    const isLoginPost = request.method.toUpperCase() === 'POST' && url.pathname === g.loginPath

    const result = await g.handle({
      method: request.method,
      path: url.pathname,
      search: url.search,
      cookie: event.cookies.get(g.cookieName),
      body: isLoginPost ? await request.text() : undefined,
    })

    switch (result.type) {
      case 'pass':
        return resolve(event)
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
