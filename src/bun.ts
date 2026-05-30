import { createGate, type GateOptions, readCookie } from './core'

type FetchHandler = (request: Request) => Response | Promise<Response>

/**
 * Bun.serve adapter. Wraps a fetch handler: the gate runs first, and on `pass`
 * the wrapped handler is called; otherwise the gate's response is returned.
 *
 *   import { gate } from 'sitepass/bun'
 *   Bun.serve({ fetch: gate(myHandler) })
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment (Bun loads .env).
 */
export function gate(
  handler: FetchHandler,
  options: Omit<GateOptions, 'password' | 'secret'> = {},
): FetchHandler {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
  })

  return async (request) => {
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
        return handler(request)
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
