import { describe, expect, it } from 'vitest'
import { createGate, type GateOptions, type GateResult, readCookie } from '../src/core'
import { PASSWORD, SECRET } from './fixtures/credentials'

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
    // Must not over-match a shorter or sibling path, and the match is on whole
    // segments: a naive startsWith would let "/api/webhooksxyz" through.
    expect(await pass('/api/webhooksxyz')).toBe('html')
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

  it('7f. encoded backslash, double-encoding, and path-param traversal are rejected too', async () => {
    const g = gate({ publicPaths: ['/assets'] })
    const probe = async (path: string) => (await g.handle({ method: 'GET', path })).type
    expect(await probe('/assets/..%5c..%5csecret')).toBe('html') // encoded backslash
    expect(await probe('/assets/..%252f..%252fsecret')).toBe('html') // double-encoded slash
    expect(await probe('/assets/%2e%2e%2fsecret')).toBe('html') // encoded dot+slash
    expect(await probe('/assets/..;/secret')).toBe('html') // literal path-parameter segment
    expect(await probe('/assets/..%3b/secret')).toBe('html') // encoded semicolon
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

  it('14. the logout path clears the cookie (GET/POST only) and works under a publicPaths prefix', async () => {
    const g = gate({ publicPaths: ['/__gate'] })
    const token = await mintCookie(g)
    const res = asRedirect(await g.handle({ method: 'GET', path: '/__gate/logout', cookie: token }))
    expect(res.location).toBe('/')
    expect(res.setCookie).toContain('Max-Age=0')
    expect(readCookie(res.setCookie, g.cookieName)).toBe('')
    // POST logs out too (a logout form); other methods do not trigger logout.
    expect((await g.handle({ method: 'POST', path: '/__gate/logout', cookie: token })).type).toBe(
      'redirect',
    )
    expect((await g.handle({ method: 'DELETE', path: '/__gate/logout', cookie: token })).type).toBe(
      'pass',
    )
  })

  it('21. a NaN or non-positive sessionSeconds falls back to the default instead of a NaN expiry', async () => {
    const bad = gate({ sessionSeconds: Number.NaN })
    const res = asRedirect(await login(bad, PASSWORD))
    expect(res.setCookie).not.toContain('NaN')
    // The minted cookie must actually validate (no silent login loop).
    const token = readCookie(res.setCookie, bad.cookieName) ?? ''
    expect((await bad.handle({ method: 'GET', path: '/x', cookie: token })).type).toBe('pass')
  })

  it('21b. a fractional sessionSeconds is floored so the minted cookie still validates', async () => {
    for (const seconds of [86400.5, 3600.999]) {
      const g = gate({ sessionSeconds: seconds })
      const res = asRedirect(await login(g, PASSWORD))
      expect(res.setCookie.endsWith(`Max-Age=${Math.floor(seconds)}`)).toBe(true)
      const token = readCookie(res.setCookie, g.cookieName) ?? ''
      expect((await g.handle({ method: 'GET', path: '/x', cookie: token })).type).toBe('pass')
    }
    // 0.5 floors to 0: an immediately expired token, same as sessionSeconds: 0 —
    // not a fractional expiry the verifier can never accept.
    const res = asRedirect(await login(gate({ sessionSeconds: 0.5 }), PASSWORD))
    expect(res.setCookie.endsWith('Max-Age=0')).toBe(true)
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

  it('19. onAuthFailure fires with a redacted view; a throwing observer is contained', async () => {
    const seen: Array<{ method: string; path: string }> = []
    const g = gate({
      onAuthFailure: (info) => {
        seen.push(info)
        throw new Error('observer blew up')
      },
    })
    const res = await login(g, 'nope')
    expect(asHtml(res).status).toBe(401)
    expect(seen).toEqual([{ method: 'POST', path: '/__gate' }])
    // The redacted payload carries no password or cookie field to leak into logs.
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['method', 'path'])
    // A correct login must not fire it.
    asRedirect(await login(g, PASSWORD))
    expect(seen).toHaveLength(1)
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

  it('22. the failed-login page ties the error to the input for assistive tech', async () => {
    // role="alert" is inert on a server-rendered page (it only announces on
    // dynamic insertion), so the aria-describedby association from the focused
    // input is what makes the error discoverable to screen-reader users.
    const res = asHtml(await login(gate(), 'nope'))
    expect(res.body).toContain('id="sitepass-error"')
    expect(res.body).toContain('aria-invalid="true"')
    expect(res.body).toContain('aria-describedby="sitepass-error"')
    // The clean login page must not claim the field is invalid.
    const clean = asHtml(await gate().handle({ method: 'GET', path: '/secret' }))
    expect(clean.body).not.toContain('aria-invalid')
    expect(clean.body).not.toContain('sitepass-error')
  })

  it('23. the default page declares its color schemes and AA-compliant colors', async () => {
    const res = asHtml(await gate().handle({ method: 'GET', path: '/secret' }))
    // Without color-scheme the UA keeps its own surfaces (canvas, form-control
    // internals, scrollbars) light for dark-mode users despite the dark theme.
    expect(res.body).toContain('<meta name="color-scheme" content="light dark" />')
    expect(res.body).toContain('color-scheme: light dark')
    // Input border: 4.83:1 on the light card, 3.67:1 on the dark card (≥3:1,
    // WCAG 1.4.11). Dark error text: 6.40:1 on the dark card (≥4.5:1, AA).
    expect(res.body).toContain('border: 1px solid #71717a')
    expect(res.body).toContain('.error { color: #f87171; }')
    // dvh keeps the card centered under mobile dynamic toolbars; the vh
    // declaration before it is the fallback where dvh is unsupported.
    expect(res.body).toContain('min-height: 100vh; min-height: 100dvh;')
  })

  it('12. a valid brand accent is preserved', async () => {
    const hex = gate({ brand: { accent: '#0af' } })
    expect(asHtml(await hex.handle({ method: 'GET', path: '/' })).body).toContain('--accent: #0af')

    const fn = gate({ brand: { accent: 'rgb(10 20 30 / 50%)' } })
    expect(asHtml(await fn.handle({ method: 'GET', path: '/' })).body).toContain(
      '--accent: rgb(10 20 30 / 50%)',
    )
  })

  it('24. a non-ASCII password with form-special characters round-trips end-to-end', async () => {
    // URLSearchParams (via formBody) encodes the way a browser submits a form —
    // '+' for spaces, percent-escaped UTF-8 — so this pins the whole
    // decode → TextEncoder → HMAC pipeline, not just the comparison.
    const password = 'pässwörd+&=100% 秘密'
    const g = gate({ password })
    const res = asRedirect(await login(g, password, '/dashboard'))
    expect(res.location).toBe('/dashboard')
    const token = readCookie(res.setCookie, g.cookieName)
    expect(token).toBeTruthy()
    // The minted cookie validates on a later request.
    expect((await g.handle({ method: 'GET', path: '/secret', cookie: token })).type).toBe('pass')
    // And the ASCII fixture password no longer matches this gate.
    expect(asHtml(await login(g, PASSWORD)).status).toBe(401)
  })
})

// The contract every adapter depends on to extract the session token.
describe('readCookie', () => {
  it('returns undefined for a missing header or a jar without the cookie', () => {
    expect(readCookie(undefined, 'gate')).toBeUndefined()
    expect(readCookie(null, 'gate')).toBeUndefined()
    expect(readCookie('', 'gate')).toBeUndefined()
    expect(readCookie('other=1; theme=dark', 'gate')).toBeUndefined()
  })

  it('matches the whole cookie name, not a prefix', () => {
    expect(readCookie('gateway=x; gate=y', 'gate')).toBe('y')
    expect(readCookie('gateway=x', 'gate')).toBeUndefined()
  })

  it('skips valueless parts and trims whitespace around name and value', () => {
    expect(readCookie('flag; gate=y', 'gate')).toBe('y')
    expect(readCookie(' gate = y ', 'gate')).toBe('y')
  })

  it('returns the value verbatim, including embedded "="', () => {
    expect(readCookie('gate=a=b', 'gate')).toBe('a=b')
    expect(readCookie('gate=', 'gate')).toBe('')
  })
})
