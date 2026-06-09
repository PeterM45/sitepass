import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createGate, type GateOptions } from './core'
import { gateWebRequest } from './web'

export type NextGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number | undefined
}

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
export function gate({ maxBodyBytes, ...options }: NextGateOptions = {}) {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
    bypassToken: options.bypassToken ?? process.env.SITEPASS_BYPASS_TOKEN,
  })

  return async (request: NextRequest): Promise<Response> => {
    const response = await gateWebRequest(g, request, maxBodyBytes)
    if (!response) return NextResponse.next()
    if (response.status === 302) {
      // Keep Next's idiom for redirects: NextResponse.redirect wants an
      // absolute URL, resolved against the incoming request.
      const location = response.headers.get('location') ?? '/'
      const redirect = NextResponse.redirect(new URL(location, request.url), 302)
      const cookie = response.headers.get('set-cookie')
      if (cookie) redirect.headers.append('Set-Cookie', cookie)
      return redirect
    }
    return response
  }
}
