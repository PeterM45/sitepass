import type { Context, MiddlewareHandler } from 'hono'
import { createGate, type Gate, type GateOptions, readCookie } from './core'

/**
 * Hono middleware adapter.
 *
 * Wire it up on your app, before the routes it guards:
 *
 *   import { gate } from 'sitepass/hono'
 *   app.use(gate())
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment. Env is read from
 * `c.env` (Cloudflare bindings) with a process.env fallback for Node and Bun.
 */
export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}): MiddlewareHandler {
  // c.env is only available per request, so build the gate on first use.
  let cached: Gate | undefined
  const gateFor = (c: Context) => {
    cached ??= createGate({
      ...options,
      password: readEnv(c, 'SITEPASS_PASSWORD'),
      secret: readEnv(c, 'SITEPASS_SECRET'),
    })
    return cached
  }

  return async (c, next) => {
    const g = gateFor(c)
    const url = new URL(c.req.url)
    const isLoginPost = c.req.method.toUpperCase() === 'POST' && url.pathname === g.loginPath

    const result = await g.handle({
      method: c.req.method,
      path: url.pathname,
      search: url.search,
      cookie: readCookie(c.req.header('cookie'), g.cookieName),
      body: isLoginPost ? await c.req.text() : undefined,
    })

    switch (result.type) {
      case 'pass':
        await next()
        return
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

function readEnv(c: Context, name: string): string {
  const fromBindings = (c.env as Record<string, string | undefined> | undefined)?.[name]
  if (fromBindings != null) return fromBindings
  // process is absent on Workers; guard so the fallback never throws there.
  return (typeof process !== 'undefined' ? process.env[name] : undefined) ?? ''
}
