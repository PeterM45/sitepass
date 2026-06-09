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

  it('7b. an encoded slash/dot cannot smuggle traversal past a publicPaths prefix', async () => {
    const g = gate({ publicPaths: ['/assets'] })
    const probe = async (path: string) => (await g.handle({ method: 'GET', path })).type
    // A genuine public asset still passes.
    expect(await probe('/assets/app.css')).toBe('pass')
    // A percent-encoded slash (%2f) or dot-segment (%2e) used to bounce out of the
    // public prefix toward gated content must fall through to the gate, not pass.
    expect(await probe('/assets/..%2f..%2fsecret')).toBe('html')
    expect(await probe('/assets/%2e%2e/secret')).toBe('html')
  })

  it('7c. a literal dot-segment cannot smuggle traversal past a publicPaths prefix', async () => {
    const g = gate({ publicPaths: ['/assets'] })
    const probe = async (path: string) => (await g.handle({ method: 'GET', path })).type
    // The reverse proxy and Express hand over the raw request target, so the
    // literal forms must be rejected just like the encoded ones.
    expect(await probe('/assets/../secret')).toBe('html')
    expect(await probe('/assets/./../secret')).toBe('html')
    expect(await probe('/assets/..\\secret')).toBe('html')
    // A trailing-slash entry behaves the same as its bare form.
    const slash = gate({ publicPaths: ['/assets/'] })
    expect((await slash.handle({ method: 'GET', path: '/assets/app.css' })).type).toBe('pass')
    expect((await slash.handle({ method: 'GET', path: '/assets' })).type).toBe('pass')
    expect((await slash.handle({ method: 'GET', path: '/assets/../secret' })).type).toBe('html')
  })

  it('7d. a "/" or empty publicPaths entry does not un-gate the whole site', async () => {
    const g = gate({ publicPaths: ['/'] })
    expect((await g.handle({ method: 'GET', path: '/' })).type).toBe('pass')
    expect((await g.handle({ method: 'GET', path: '/secret' })).type).toBe('html')

    const empty = gate({ publicPaths: [''] })
    expect((await empty.handle({ method: 'GET', path: '/secret' })).type).toBe('html')
  })

  it('7e. a publicPaths entry covering loginPath does not break login', async () => {
    // "The login page must be public" is a natural misconfiguration; the login
    // POST must still be handled by the gate, not passed through to the app.
    const g = gate({ publicPaths: ['/__gate'] })
    const res = asRedirect(await login(g, PASSWORD, '/dashboard'))
    expect(res.location).toBe('/dashboard')
    expect(readCookie(res.setCookie, g.cookieName)).toBeTruthy()
  })

  it('8. open-redirect attempts fall back to "/" while a safe next is preserved', async () => {
    const g = gate()
    expect(asRedirect(await login(g, PASSWORD, '//evil.com')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, 'https://evil.com')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, '/dashboard')).location).toBe('/dashboard')
  })

  it('8b. control characters in next cannot inject headers via Location', async () => {
    const g = gate()
    expect(asRedirect(await login(g, PASSWORD, '/x\r\nSet-Cookie: pwned=1')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, '/x\npwned')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, '/x\tpwned')).location).toBe('/')
    expect(asRedirect(await login(g, PASSWORD, '/\\evil.com')).location).toBe('/')
  })

  it('9. unconfigured fails closed by default and opens only with failOpen', async () => {
    const closed = createGate({ password: '', secret: '' })
    expect(asHtml(await closed.handle({ method: 'GET', path: '/' })).status).toBe(503)

    const open = createGate({ password: '', secret: '', failOpen: true })
    expect((await open.handle({ method: 'GET', path: '/' })).type).toBe('pass')
  })

  it('13. rotating the password invalidates outstanding sessions', async () => {
    const token = await mintCookie(gate())
    const rotated = gate({ password: 'a brand new passphrase' })
    const res = await rotated.handle({ method: 'GET', path: '/', cookie: token })
    expect(res.type).toBe('html')
  })

  it('14. the logout path clears the cookie and works even under a publicPaths prefix', async () => {
    const g = gate({ publicPaths: ['/__gate'] })
    const token = await mintCookie(g)
    const res = asRedirect(await g.handle({ method: 'GET', path: '/__gate/logout', cookie: token }))
    expect(res.location).toBe('/')
    expect(res.setCookie).toContain('Max-Age=0')
    expect(readCookie(res.setCookie, g.cookieName)).toBe('')
  })

  it('15. a matching bypass token passes without a session; a wrong one does not', async () => {
    const g = gate({ bypassToken: 'ci-bypass-token-123' })
    const ok = await g.handle({ method: 'GET', path: '/x', bypassToken: 'ci-bypass-token-123' })
    expect(ok.type).toBe('pass')
    const bad = await g.handle({ method: 'GET', path: '/x', bypassToken: 'wrong' })
    expect(bad.type).toBe('html')
    // An unconfigured bypass never matches, even on an empty submitted value.
    const none = await gate().handle({ method: 'GET', path: '/x', bypassToken: '' })
    expect(none.type).toBe('html')
  })

  it('16. cookieSecure: false omits the Secure attribute; the default keeps it', async () => {
    const insecure = gate({ cookieSecure: false })
    expect(asRedirect(await login(insecure, PASSWORD)).setCookie).not.toContain('Secure')
    expect(asRedirect(await login(gate(), PASSWORD)).setCookie).toContain('Secure')
  })

  it('17. a secret shorter than 16 characters counts as unconfigured and fails closed', async () => {
    const weak = createGate({ password: PASSWORD, secret: 'abc' })
    expect(asHtml(await weak.handle({ method: 'GET', path: '/' })).status).toBe(503)
  })

  it('18. a custom renderLoginPage replaces the built-in page', async () => {
    const g = gate({
      renderLoginPage: ({ loginPath, next, error }) =>
        `<form action="${loginPath}"><input name="next" value="${next}" />${error}</form>`,
    })
    const res = asHtml(await g.handle({ method: 'GET', path: '/secret' }))
    expect(res.body).toContain('action="/__gate"')
    expect(res.body).toContain('value="/secret"')
    expect(res.body).toContain('false')
  })

  it('19. onAuthFailure fires on a wrong password and a throwing observer is contained', async () => {
    const seen: string[] = []
    const g = gate({
      onAuthFailure: (request) => {
        seen.push(request.path)
        throw new Error('observer blew up')
      },
    })
    const res = await login(g, 'nope')
    expect(asHtml(res).status).toBe(401)
    expect(seen).toEqual(['/__gate'])
    // A correct login must not fire it.
    asRedirect(await login(g, PASSWORD))
    expect(seen).toEqual(['/__gate'])
  })

  it('20. malformed session tokens are rejected, not thrown', async () => {
    const g = gate()
    const probe = async (cookie: string) =>
      (await g.handle({ method: 'GET', path: '/', cookie })).type
    expect(await probe('no-dot-token')).toBe('html')
    expect(await probe('!!!.???')).toBe('html')
    // Valid base64 but a signature that is not 32 bytes.
    expect(await probe('MTIzNA.c2hvcnQ')).toBe('html')
    // Correctly signed but non-numeric payload.
    const real = await mintCookie(g)
    const signature = real.slice(real.indexOf('.') + 1)
    expect(await probe(`bm90LWEtbnVtYmVy.${signature}`)).toBe('html')
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
