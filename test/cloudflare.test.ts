import { describe, expect, it } from 'vitest'
import { gate } from '../src/cloudflare'
import { readCookie } from '../src/core'

// This proves the SPA-via-edge story: an SPA cannot gate itself, but the
// Cloudflare adapter runs before the static asset is served, so the SPA shell is
// only delivered once a valid cookie is present.

const SPA_SHELL =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
const ENV = { SITEPASS_PASSWORD: 'open-sesame', SITEPASS_SECRET: 'an-edge-secret-value-1234567890' }

function context(request: Request, env: Record<string, string | undefined> = ENV) {
  // next() stands in for Cloudflare's static asset server.
  return {
    request,
    env,
    next: async () => new Response(SPA_SHELL, { headers: { 'content-type': 'text/html' } }),
  }
}

describe('cloudflare adapter gates a static SPA at the edge', () => {
  const onRequest = gate()

  it('serves the login page, not the SPA shell, without a cookie', async () => {
    const res = await onRequest(context(new Request('https://app.test/')))
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).not.toContain('id="root"')
    expect(body.toLowerCase()).toContain('password')
  })

  it('serves the SPA shell after a correct login', async () => {
    const loginRes = await onRequest(
      context(
        new Request('https://app.test/__gate', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'password=open-sesame&next=/',
        }),
      ),
    )
    expect(loginRes.status).toBe(302)
    const token = readCookie(loginRes.headers.get('set-cookie'), 'gate')
    if (!token) throw new Error('no cookie set on login')

    const res = await onRequest(
      context(new Request('https://app.test/', { headers: { cookie: `gate=${token}` } })),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
  })
})
