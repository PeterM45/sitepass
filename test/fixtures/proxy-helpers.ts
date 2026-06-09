import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { readCookie } from '../../src/core'
import { type ProxyOptions, startProxy } from '../../src/proxy'
import { PASSWORD, SECRET } from './credentials'

/**
 * Shared harness for the proxy test files. Every server opened through it is
 * tracked so closeAll() (each file's afterEach) never leaks a port between tests.
 */

const open: Server[] = []

export function closeAll() {
  for (const server of open.splice(0)) server.close()
}

export function listen(
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

export function proxy(options: Omit<ProxyOptions, 'port'>): Promise<number> {
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

/**
 * The standard fixture: an origin running `handler` behind a proxy gated with
 * the shared credentials, plus any extra proxy options (maxBodyBytes,
 * trustProxy, …). Both servers are tracked for closeAll().
 */
export async function gatedProxy(
  handler: Parameters<typeof createServer>[1],
  options: Omit<ProxyOptions, 'origin' | 'port' | 'password' | 'secret'> = {},
): Promise<{ originPort: number; proxyPort: number }> {
  const origin = await listen(handler)
  const proxyPort = await proxy({
    origin: `http://127.0.0.1:${origin.port}`,
    password: PASSWORD,
    secret: SECRET,
    ...options,
  })
  return { originPort: origin.port, proxyPort }
}

/**
 * gatedProxy whose origin records the headers of the last request it served —
 * the forwarding tests assert on what actually reached the origin.
 */
export async function headerCapturingProxy(
  options: Omit<ProxyOptions, 'origin' | 'port' | 'password' | 'secret'> = {},
): Promise<{
  originPort: number
  proxyPort: number
  headers: () => Record<string, string | string[] | undefined>
}> {
  let seen: Record<string, string | string[] | undefined> = {}
  const ports = await gatedProxy((req, res) => {
    seen = req.headers
    res.end('OK')
  }, options)
  return { ...ports, headers: () => seen }
}

export async function loginCookie(port: number): Promise<string> {
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
// targets (and forbidden headers like Connection) that a normal HTTP client would
// normalize away. Resolves with the status line.
export function rawRequest(port: number, requestLine: string, headers: string[]): Promise<string> {
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
