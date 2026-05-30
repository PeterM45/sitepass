import { createGate, type GateOptions } from './core'

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

// `Netlify` is a global in the Edge Functions runtime; declared here so the
// adapter typechecks without depending on @netlify/edge-functions.
declare const Netlify: { env: { get(key: string): string | undefined } }

interface NetlifyContext {
  next: () => Promise<Response>
  cookies: { get(name: string): string | undefined }
}

export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}) {
  const g = createGate({
    ...options,
    password: Netlify.env.get('SITEPASS_PASSWORD') ?? '',
    secret: Netlify.env.get('SITEPASS_SECRET') ?? '',
  })

  return async (request: Request, context: NetlifyContext): Promise<Response> => {
    const url = new URL(request.url)
    const isLoginPost = request.method.toUpperCase() === 'POST' && url.pathname === g.loginPath

    const result = await g.handle({
      method: request.method,
      path: url.pathname,
      search: url.search,
      cookie: context.cookies.get(g.cookieName),
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

// Run on every path. Re-export this from your edge function file.
export const config = { path: '/*' }
