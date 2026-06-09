import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { PASSWORD, SECRET } from './fixtures/credentials'
import { closeAll, listen, loginCookie, proxy, rawRequest } from './fixtures/proxy-helpers'

// Servers opened by a test are torn down after it so ports never leak between tests.
afterEach(closeAll)

describe('reverse proxy gating', () => {
  it('gates before forwarding: an unauthenticated request never reaches the origin', async () => {
    let originHits = 0
    const origin = await listen((_req, res) => {
      originHits++
      res.end('ORIGIN')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const res = await fetch(`http://127.0.0.1:${port}/secret`, { redirect: 'manual' })
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
    expect(originHits).toBe(0)
  })

  it('forwards the request path to the origin once a valid cookie is present', async () => {
    const origin = await listen((req, res) => res.end(`ORIGIN ${req.url}`))
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/secret?ref=x`, {
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ORIGIN /secret?ref=x')
  })

  it('never lets a crafted request target choose the upstream host (SSRF / cookie exfiltration)', async () => {
    let attackerHits = 0
    const attacker = await listen((_req, res) => {
      attackerHits++
      res.end('ATTACKER')
    })
    let originHits = 0
    const origin = await listen((_req, res) => {
      originHits++
      res.end('ORIGIN')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })
    const token = await loginCookie(port)
    const host = `Host: 127.0.0.1:${port}`
    const cookie = `Cookie: gate=${token}`

    // Protocol-relative and absolute-form targets both pointed at the attacker.
    const protoRelative = await rawRequest(
      port,
      `GET //127.0.0.1:${attacker.port}/steal HTTP/1.1`,
      [host, cookie],
    )
    const absolute = await rawRequest(
      port,
      `GET http://127.0.0.1:${attacker.port}/steal HTTP/1.1`,
      [host, cookie],
    )

    expect(attackerHits).toBe(0)
    expect(protoRelative).toContain('200')
    expect(absolute).toContain('200')
    // The requests were pinned to the real origin instead.
    expect(originHits).toBe(2)
  })
})

describe('reverse proxy robustness', () => {
  it('preserves every Set-Cookie the origin sends', async () => {
    const origin = await listen((_req, res) => {
      res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/'])
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/x`, { headers: { cookie: `gate=${token}` } })
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies.some((c) => c.startsWith('a=1'))).toBe(true)
    expect(cookies.some((c) => c.startsWith('b=2'))).toBe(true)
  })

  it('rejects an over-sized request body with 413 instead of buffering it unbounded', async () => {
    const origin = await listen((_req, res) => res.end('OK'))
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
      maxBodyBytes: 1024,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { cookie: `gate=${token}` },
      body: 'x'.repeat(50_000),
    })
    expect(res.status).toBe(413)
  })

  it('survives an upstream connection reset mid-body instead of crashing the process', async () => {
    // The reset must happen AFTER the proxy has forwarded the response headers,
    // so the failure lands in the body-streaming pipeline rather than the
    // pre-stream 502 path. The origin parks the response and the test destroys
    // it only once the client has read the first proxied chunk.
    let parked: ServerResponse | undefined
    const origin = await listen((_req, res) => {
      parked = res
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/stream`, {
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('partial')

    // Now cut the upstream mid-body; reading the rest must fail, not crash.
    parked?.destroy()
    await reader.read().catch(() => {})

    // Proof of life: the proxy still answers (gate-served 401, origin untouched).
    const live = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    expect(live.status).toBe(401)
  })

  it('caps the unauthenticated login body with 413', async () => {
    const origin = await listen((_req, res) => res.end('OK'))
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
      maxBodyBytes: 1024,
    })

    const res = await fetch(`http://127.0.0.1:${port}/__gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${'a'.repeat(50_000)}`,
      redirect: 'manual',
    })
    expect(res.status).toBe(413)
  })
})

describe('reverse proxy forwarding', () => {
  it('forwards a request body to the origin byte-for-byte', async () => {
    const origin = await listen((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => res.end(Buffer.concat(chunks)))
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const body = JSON.stringify({ hello: 'world', n: 42 })
    const res = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { cookie: `gate=${token}`, 'content-type': 'application/json' },
      body,
    })
    expect(await res.text()).toBe(body)
  })

  it('pins host, strips hop-by-hop headers and the gate cookie, and adds X-Forwarded-*', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: {
        cookie: `other=1; gate=${token}; theme=dark`,
        'x-custom': 'kept',
        'x-sitepass-bypass': 'secret-bypass',
        'proxy-authorization': 'Basic should-be-stripped',
        forwarded: 'for=9.9.9.9;host=evil.com',
      },
    })
    expect(res.status).toBe(200)

    // Host is pinned to the origin, never taken from the client request.
    expect(seen.host).toBe(`127.0.0.1:${origin.port}`)
    // The gate's own session token never reaches the origin; other cookies do.
    expect(seen.cookie).toBe('other=1; theme=dark')
    // The bypass credential is stripped too — it must not leak to origin logs.
    expect(seen['x-sitepass-bypass']).toBeUndefined()
    // Ordinary headers pass through; hop-by-hop and the RFC 7239 Forwarded
    // header (which we don't re-emit) do not.
    expect(seen['x-custom']).toBe('kept')
    expect(seen['proxy-authorization']).toBeUndefined()
    expect(seen.forwarded).toBeUndefined()
    // Forwarded-request metadata names the real client (Node may report the
    // loopback as the IPv4-mapped IPv6 form ::ffff:127.0.0.1).
    expect(seen['x-forwarded-for']).toContain('127.0.0.1')
    expect(seen['x-forwarded-proto']).toBe('http')
    expect(seen['x-forwarded-host']).toBe(`127.0.0.1:${port}`)
  })

  it('drops request headers named by the inbound Connection header', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })
    const token = await loginCookie(port)

    // fetch forbids the Connection header, so speak raw HTTP: a request can
    // declare any header connection-scoped, and the proxy must consume it
    // (RFC 7230 §6.1) rather than smuggle it past the static hop-by-hop list.
    const status = await rawRequest(port, 'GET /x HTTP/1.1', [
      `Host: 127.0.0.1:${port}`,
      `Cookie: gate=${token}`,
      'Connection: X-Hop',
      'X-Hop: leak',
      'X-Kept: ok',
    ])
    expect(status).toContain('200')
    expect(seen['x-hop']).toBeUndefined()
    expect(seen['x-kept']).toBe('ok')
  })

  it('drops response headers named by the upstream Connection header', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(200, { connection: 'x-resp-hop', 'x-resp-hop': 'leak', 'x-kept': 'ok' })
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-resp-hop')).toBeNull()
    expect(res.headers.get('x-kept')).toBe('ok')
  })

  it('sets X-Forwarded-* authoritatively, ignoring client-spoofed values', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    await fetch(`http://127.0.0.1:${port}/x`, {
      headers: {
        cookie: `gate=${token}`,
        'x-forwarded-for': '9.9.9.9',
        'x-forwarded-host': 'evil.com',
        'x-forwarded-proto': 'https',
      },
    })
    // The proxy is the trust boundary: a spoofed XFF must not survive, and host
    // injection / cache poisoning via x-forwarded-host must not reach the origin.
    expect(seen['x-forwarded-for']).not.toContain('9.9.9.9')
    expect(seen['x-forwarded-for']).toContain('127.0.0.1')
    expect(seen['x-forwarded-host']).toBe(`127.0.0.1:${port}`)
    expect(seen['x-forwarded-proto']).toBe('http')
  })

  it('passes the front hop X-Forwarded-* through under trustProxy, appending the peer', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
      trustProxy: true,
    })

    const token = await loginCookie(port)
    await fetch(`http://127.0.0.1:${port}/x`, {
      headers: {
        cookie: `gate=${token}`,
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'staging.example.com',
      },
    })
    // The TLS terminator's view reaches the origin: real client IP first, the
    // terminator (here the loopback test client) appended to the chain.
    expect(seen['x-forwarded-for']).toMatch(/^203\.0\.113\.7, .*127\.0\.0\.1/)
    expect(seen['x-forwarded-proto']).toBe('https')
    expect(seen['x-forwarded-host']).toBe('staging.example.com')
  })

  it('falls back to socket-derived X-Forwarded-* under trustProxy when none arrive', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
      trustProxy: true,
    })

    const token = await loginCookie(port)
    await fetch(`http://127.0.0.1:${port}/x`, { headers: { cookie: `gate=${token}` } })
    expect(seen['x-forwarded-for']).toContain('127.0.0.1')
    expect(seen['x-forwarded-proto']).toBe('http')
    expect(seen['x-forwarded-host']).toBe(`127.0.0.1:${port}`)
  })

  it('drops the Cookie header entirely when the gate cookie was the only one', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const origin = await listen((req, res) => {
      seen = req.headers
      res.end('OK')
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    await fetch(`http://127.0.0.1:${port}/x`, { headers: { cookie: `gate=${token}` } })
    expect(seen.cookie).toBeUndefined()
  })
})
