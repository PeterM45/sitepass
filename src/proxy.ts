import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createGate, type GateOptions, readCookie, sanitizeNext } from './core'

/**
 * Standalone reverse proxy that gates requests and, on pass, forwards them to a
 * configured origin and streams the response back. The escape hatch for
 * self-hosted static sites with no edge layer. Driven by `sitepass proxy`.
 *
 * This runs in Node, so unlike the core it may use Node APIs.
 */
export type ProxyOptions = GateOptions & { origin: string; port: number }

// Headers that are connection-specific and must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
])

export function startProxy({ origin, port, ...gateOptions }: ProxyOptions) {
  const gate = createGate(gateOptions)
  const originUrl = new URL(origin)

  const server = createServer((req, res) => {
    handle(req, res, gate, originUrl).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Bad gateway')
    })
  })

  server.listen(port)
  return server
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  gate: ReturnType<typeof createGate>,
  origin: URL,
) {
  const method = req.method ?? 'GET'
  const rawUrl = req.url ?? '/'
  const queryAt = rawUrl.indexOf('?')
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)
  const search = queryAt === -1 ? '' : rawUrl.slice(queryAt)
  const isLoginPost = method.toUpperCase() === 'POST' && path === gate.loginPath

  const result = await gate.handle({
    method,
    path,
    search,
    cookie: readCookie(req.headers.cookie, gate.cookieName),
    body: isLoginPost ? await readBody(req) : undefined,
  })

  switch (result.type) {
    case 'pass':
      return forward(req, res, origin)
    case 'redirect':
      res.writeHead(302, { Location: result.location, 'Set-Cookie': result.setCookie })
      res.end()
      return
    case 'html':
      res.writeHead(result.status, result.headers)
      res.end(result.body)
      return
  }
}

async function forward(req: IncomingMessage, res: ServerResponse, origin: URL) {
  // Pin the upstream host to the configured origin and copy only the request's
  // path+query onto it. The host must never come from the request line: a target
  // like "//evil.com/x" or "https://evil.com/x" arrives verbatim in req.url, and
  // `new URL(req.url, origin)` would resolve to the attacker's host — turning the
  // proxy into an SSRF pivot that also leaks the forwarded gate cookie. sanitizeNext
  // collapses those forms (and CR/LF) to "/", and assigning pathname keeps the host.
  const target = new URL(origin.href)
  const safePath = sanitizeNext(req.url ?? '/')
  const queryAt = safePath.indexOf('?')
  target.pathname = queryAt === -1 ? safePath : safePath.slice(0, queryAt)
  target.search = queryAt === -1 ? '' : safePath.slice(queryAt)

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('host', target.host)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await readBuffer(req) : undefined,
    redirect: 'manual',
  })

  const outHeaders: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    // Drop content-encoding/length: fetch already decoded the body, so the
    // original values no longer match what we stream out.
    if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'content-length') return
    outHeaders[name] = value
  })

  res.writeHead(upstream.status, outHeaders)
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res)
  } else {
    res.end()
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function readBuffer(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => resolve(concat(chunks)))
    req.on('error', reject)
  })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
