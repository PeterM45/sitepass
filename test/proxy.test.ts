import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { readCookie } from '../src/core'
import { type ProxyOptions, startProxy } from '../src/proxy'

const PASSWORD = 'correct horse battery staple'
const SECRET = 'a-test-secret-that-is-plenty-long-1234567890'

// Servers opened by a test, torn down after it so ports never leak between tests.
const open: Server[] = []
afterEach(() => {
  for (const server of open.splice(0)) server.close()
})

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  open.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({ server, port: address.port })
    })
  })
}

function proxy(options: Omit<ProxyOptions, 'port'>): Promise<number> {
  const server = startProxy({ ...options, port: 0 })
  open.push(server)
  return new Promise((resolve) => {
    server.on('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })
}

async function loginCookie(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/__gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASSWORD)}&next=/`,
    redirect: 'manual',
  })
  const token = readCookie(res.headers.get('set-cookie'), 'gate')
  if (!token) throw new Error(`no cookie minted (status ${res.status})`)
  return token
}

// Send a raw request line so we can express the absolute-form and protocol-relative
// targets that a normal HTTP client would normalize away. Resolves with the status line.
function rawRequest(port: number, requestLine: string, headers: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      data += chunk
    })
    socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''))
    socket.on('error', reject)
  })
}

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
