import { describe, expect, it } from 'vitest'
import { createGate, type GateOptions, type GateResult, readCookie } from '../src/core'

const PASSWORD = 'correct horse battery staple'
const SECRET = 'a-test-secret-that-is-plenty-long-1234567890'

function gate(overrides: Partial<GateOptions> = {}) {
  return createGate({ password: PASSWORD, secret: SECRET, ...overrides })
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

function login(g: ReturnType<typeof gate>, password: string, next?: string) {
  const fields: Record<string, string> = { password }
  if (next !== undefined) fields.next = next
  return g.handle({ method: 'POST', path: g.loginPath, body: formBody(fields) })
}

function asRedirect(res: GateResult) {
  if (res.type !== 'redirect') throw new Error(`expected redirect, got ${res.type}`)
  return res
}

function asHtml(res: GateResult) {
  if (res.type !== 'html') throw new Error(`expected html, got ${res.type}`)
  return res
}

async function mintCookie(g: ReturnType<typeof gate>): Promise<string> {
  const res = asRedirect(await login(g, PASSWORD))
  const token = readCookie(res.setCookie, g.cookieName)
  if (!token) throw new Error('no cookie minted')
  return token
}

describe('createGate', () => {
  it('1. correct password POST returns a redirect with a hardened cookie', async () => {
    const res = asRedirect(await login(gate(), PASSWORD, '/dashboard'))
    expect(res.location).toBe('/dashboard')
    expect(res.setCookie).toContain('HttpOnly')
    expect(res.setCookie).toContain('Secure')
    expect(res.setCookie).toContain('SameSite=Lax')
  })

  it('2. wrong password POST returns a 401 page and sets no cookie', async () => {
    const res = await login(gate(), 'nope')
    const html = asHtml(res)
    expect(html.status).toBe(401)
    expect('setCookie' in res).toBe(false)
  })

  it('3. a cookie minted under one secret is rejected by a gate with a different secret', async () => {
    const token = await mintCookie(gate({ secret: 'secret-number-one-aaaaaaaaaaaaaaaaaaaa' }))
    const other = gate({ secret: 'secret-number-two-bbbbbbbbbbbbbbbbbbbb' })
    const res = await other.handle({ method: 'GET', path: '/', cookie: token })
    expect(res.type).toBe('html')
  })

  it('4. a cookie with a tampered signature is rejected', async () => {
    const g = gate()
    const token = await mintCookie(g)
    const dot = token.indexOf('.')
    const signature = token.slice(dot + 1)
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    const tampered = `${token.slice(0, dot)}.${flipped}`
    const res = await g.handle({ method: 'GET', path: '/', cookie: tampered })
    expect(res.type).toBe('html')
  })

  it('5. an expired token is rejected', async () => {
    // Mint with a session that is already in the past; the signature is valid
    // but the expiry check must still reject it.
    const expired = await mintCookie(gate({ sessionSeconds: -10 }))
    const res = await gate().handle({ method: 'GET', path: '/', cookie: expired })
    expect(res.type).toBe('html')
  })

  it('6. a valid, unexpired cookie on a normal GET passes', async () => {
    const g = gate()
    const token = await mintCookie(g)
    const res = await g.handle({ method: 'GET', path: '/secret', cookie: token })
    expect(res.type).toBe('pass')
  })

  it('7. publicPaths bypass the gate with prefix matching and no over-match', async () => {
    const g = gate({ publicPaths: ['/api/webhooks', '/health'] })
    const pass = async (path: string) => (await g.handle({ method: 'GET', path })).type
    expect(await pass('/api/webhooks')).toBe('pass')
    expect(await pass('/api/webhooks/stripe')).toBe('pass')
    expect(await pass('/health')).toBe('pass')
    // Must not over-match a shorter or sibling path.
    expect(await pass('/apixyz')).toBe('html')
    expect(await pass('/api')).toBe('html')
  })

  it('8. open-redirect attempts fall back to "/" while a safe next is preserved', async () => {
    const g = gate()
    expect(asRedirect(await login(g, PASSWORD, '//evil.com')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, 'https://evil.com')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, '/dashboard')).location).toBe('/dashboard')
  })

  it('9. unconfigured fails closed by default and opens only with failOpen', async () => {
    const closed = createGate({ password: '', secret: '' })
    expect(asHtml(await closed.handle({ method: 'GET', path: '/' })).status).toBe(503)

    const open = createGate({ password: '', secret: '', failOpen: true })
    expect((await open.handle({ method: 'GET', path: '/' })).type).toBe('pass')
  })

  it('10. the login page HTML-escapes the next value', async () => {
    const res = asHtml(await login(gate(), 'nope', '/"><script>alert(1)</script>'))
    expect(res.body).not.toContain('"><script>')
    expect(res.body).toContain('&lt;script&gt;')
  })

  it('11. a malicious brand accent falls back to the default instead of breaking out of <style>', async () => {
    const g = gate({ brand: { accent: 'red; } </style><script>alert(1)</script>' } })
    const res = asHtml(await g.handle({ method: 'GET', path: '/' }))
    expect(res.body).not.toContain('<script>')
    expect(res.body).not.toContain('alert(1)')
    expect(res.body).toContain('--accent: #4f46e5')
  })

  it('12. a valid brand accent is preserved', async () => {
    const hex = gate({ brand: { accent: '#0af' } })
    expect(asHtml(await hex.handle({ method: 'GET', path: '/' })).body).toContain('--accent: #0af')

    const fn = gate({ brand: { accent: 'rgb(10 20 30 / 50%)' } })
    expect(asHtml(await fn.handle({ method: 'GET', path: '/' })).body).toContain(
      '--accent: rgb(10 20 30 / 50%)',
    )
  })
})
