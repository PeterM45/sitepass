import { createGate, type Gate, type GateOptions, readCookie } from './core'

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

// The slice of the Pages Functions context this adapter touches. Consumers get
// the full PagesFunction types from @cloudflare/workers-types in their project.
interface PagesContext {
  request: Request
  env: Record<string, string | undefined>
  next: () => Promise<Response>
}

export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}) {
  // Bindings only exist at request time, so build the gate on first request and
  // reuse it (and its cached signing key) for the life of the isolate.
  let cached: Gate | undefined
  const gateFor = (env: PagesContext['env']) => {
    cached ??= createGate({
      ...options,
      password: env.SITEPASS_PASSWORD ?? '',
      secret: env.SITEPASS_SECRET ?? '',
    })
    return cached
  }

  return async (context: PagesContext): Promise<Response> => {
    const g = gateFor(context.env)
    const { request } = context
    const url = new URL(request.url)
    const isLoginPost = request.method.toUpperCase() === 'POST' && url.pathname === g.loginPath

    const result = await g.handle({
      method: request.method,
      path: url.pathname,
      search: url.search,
      cookie: readCookie(request.headers.get('cookie'), g.cookieName),
      body: isLoginPost ? await request.text() : undefined,
    })

    switch (result.type) {
      case 'pass':
        return context.next()
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
