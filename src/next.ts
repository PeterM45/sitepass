import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createGate, type GateOptions } from './core'

/**
 * Next.js middleware adapter (App Router).
 *
 * Wire it up in middleware.ts (Next 15 and earlier) or proxy.ts (Next 16+):
 *
 *   import { gate } from 'sitepass/next'
 *   export const middleware = gate()   // Next 16+: export const proxy = gate()
 *
 *   export const config = {
 *     matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
 *   }
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment. See the README
 * for the matcher tradeoff (excluding static assets keeps invocations down but
 * leaves raw JS chunks reachable; the page content stays gated).
 */
export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}) {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
  })

  return async (request: NextRequest): Promise<Response> => {
    const { nextUrl } = request
    const isLoginPost = request.method.toUpperCase() === 'POST' && nextUrl.pathname === g.loginPath

    const result = await g.handle({
      method: request.method,
      path: nextUrl.pathname,
      search: nextUrl.search,
      cookie: request.cookies.get(g.cookieName)?.value,
      body: isLoginPost ? await request.text() : undefined,
    })

    switch (result.type) {
      case 'pass':
        return NextResponse.next()
      case 'redirect': {
        const response = NextResponse.redirect(new URL(result.location, request.url), 302)
        response.headers.append('Set-Cookie', result.setCookie)
        return response
      }
      case 'html':
        return new Response(result.body, { status: result.status, headers: result.headers })
    }
  }
}
