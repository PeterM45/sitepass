import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGate, type Gate, type GateOptions, readCookie, sanitizeNext } from './core'
import {
  BodyTooLargeError,
  firstHeaderValue,
  readRawBody,
  readRawBuffer,
  splitRequestTarget,
} from './node-body'
import { BYPASS_HEADER, DEFAULT_MAX_BODY_BYTES as LOGIN_BODY_LIMIT } from './web'

// Standalone reverse proxy that gates requests and, on pass, forwards them to a
// configured origin and streams the response back. The escape hatch for
// self-hosted static sites with no edge layer. Driven by `sitepass proxy` and
// importable from 'sitepass/proxy' for custom setups.
//
// This runs in Node, so unlike the core it may use Node APIs.

export type ProxyOptions = GateOptions & {
  origin: string
  port: number
  /** Max bytes buffered from a request body before the proxy responds 413. Default: 10 MiB. */
  maxBodyBytes?: number | undefined
  /**
   * Pass the immediate peer's X-Forwarded-* through to the origin (appending the
   * peer to X-Forwarded-For) instead of overwriting them. Only safe when the
   * proxy is reachable solely through one trusted front hop, e.g. a TLS
   * terminator — anywhere a client can reach the proxy directly, leave this off
   * or clients can spoof their IP, scheme, and host to the origin. Default: false.
   */
  trustProxy?: boolean | undefined
}

const DEFAULT_MAX_FORWARD_BYTES = 10 * 1024 * 1024

// Headers the client must not control: the gate's own bypass credential, and the
// forwarded-request metadata, which a front-most proxy sets authoritatively. The
// RFC 7239 `Forwarded` header is dropped (not re-emitted) so a client can't poison
// a downstream that trusts it; we set only the X-Forwarded-* family.
const CLIENT_CONTROLLED = new Set([
  BYPASS_HEADER,
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
])

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

/**
 * Start a gating reverse proxy in front of `origin`, listening on `port`.
 * Accepts every gate option (password, secret, publicPaths, bypassToken, …)
 * plus `maxBodyBytes`. Returns the Node http.Server so callers can close it.
 */
export function startProxy({
  origin,
  port,
  maxBodyBytes = DEFAULT_MAX_FORWARD_BYTES,
  trustProxy = false,
  ...gateOptions
}: ProxyOptions) {
  const gate = createGate(gateOptions)
  const originUrl = new URL(origin)

  const server = createServer((req, res) => {
    handle(req, res, gate, originUrl, maxBodyBytes, trustProxy).catch((error) => {
      // If the response is already on its way (or the socket is gone), there is
      // nothing to send — just tear it down. Otherwise translate the failure.
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy()
        return
      }
      try {
        const tooLarge = error instanceof BodyTooLargeError
        // Connection: close — the client may still be uploading; we stopped
        // reading, so close once the response is flushed rather than draining.
        res.writeHead(tooLarge ? 413 : 502, { 'content-type': 'text/plain', connection: 'close' })
        res.end(tooLarge ? 'Payload too large' : 'Bad gateway')
      } catch {
        res.destroy()
      }
    })
  })

  server.listen(port)
  return server
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  gate: Gate,
  origin: URL,
  maxBodyBytes: number,
  trustProxy: boolean,
) {
  const method = req.method ?? 'GET'
  const { path, search } = splitRequestTarget(req.url ?? '/')
  const isLoginPost = method.toUpperCase() === 'POST' && path === gate.loginPath

  const result = await gate.handle({
    method,
    path,
    search,
    cookie: readCookie(req.headers.cookie, gate.cookieName),
    bypassToken: firstHeaderValue(req.headers[BYPASS_HEADER]),
    // The login body is tiny; cap it well below the forward limit so an
    // unauthenticated POST to the login path can't buffer up to maxBodyBytes.
    body: isLoginPost
      ? await readRawBody(req, Math.min(maxBodyBytes, LOGIN_BODY_LIMIT))
      : undefined,
  })

  switch (result.type) {
    case 'pass':
      return forward(req, res, gate, origin, maxBodyBytes, trustProxy)
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

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  gate: Gate,
  origin: URL,
  maxBodyBytes: number,
  trustProxy: boolean,
) {
  // Pin the upstream host to the configured origin and copy only the request's
  // path+query onto it. The host must never come from the request line: a target
  // like "//evil.com/x" or "https://evil.com/x" arrives verbatim in req.url, and
  // `new URL(req.url, origin)` would resolve to the attacker's host — turning the
  // proxy into an SSRF pivot that also leaks the forwarded gate cookie. sanitizeNext
  // collapses those forms (and CR/LF) to "/", and assigning pathname keeps the host.
  const target = new URL(origin.href)
  const safeTarget = splitRequestTarget(sanitizeNext(req.url ?? '/'))
  target.pathname = safeTarget.path
  target.search = safeTarget.search

  // Abort the upstream request if the client disconnects mid-flight, so a dropped
  // download doesn't leave the origin fetch running with nowhere to go.
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  const headers = new Headers()
  const connectionScoped = connectionNamed(req.headers.connection)
  for (const [name, value] of Object.entries(req.headers)) {
    // Drop hop-by-hop headers (the static set plus whatever the inbound
    // Connection header names) and any client-controlled header the proxy owns
    // (the bypass credential and the X-Forwarded-* set, re-derived below).
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      connectionScoped.has(name) ||
      CLIENT_CONTROLLED.has(name)
    ) {
      continue
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('host', target.host)
  // The gate's own session token must not leak downstream: anything that logs
  // request headers at the origin would capture a replayable credential. Same
  // for the bypass token, which CLIENT_CONTROLLED already dropped above.
  const cookieHeader = stripCookie(req.headers.cookie, gate.cookieName)
  if (cookieHeader) headers.set('cookie', cookieHeader)
  else headers.delete('cookie')
  // Forwarded-request metadata, set authoritatively by default (the inbound
  // values were dropped above): as the front-most hop, the proxy is the only
  // trustworthy source, so a client cannot spoof its IP, scheme, or host to the
  // origin. Under trustProxy the immediate peer is a trusted front hop (e.g. a
  // TLS terminator), so its X-Forwarded-* survive — the peer is appended to the
  // For chain and the real scheme/host reach the origin instead of the
  // terminator's loopback address and a hardcoded "http".
  const peer = req.socket.remoteAddress
  if (trustProxy) {
    const chain = [headerValue(req.headers['x-forwarded-for']), peer]
      .filter((part) => part !== undefined && part !== '')
      .join(', ')
    if (chain) headers.set('x-forwarded-for', chain)
    headers.set('x-forwarded-proto', headerValue(req.headers['x-forwarded-proto']) ?? 'http')
    const forwardedHost = headerValue(req.headers['x-forwarded-host']) ?? req.headers.host
    if (forwardedHost) headers.set('x-forwarded-host', forwardedHost)
  } else {
    if (peer) headers.set('x-forwarded-for', peer)
    headers.set('x-forwarded-proto', 'http')
    if (req.headers.host) headers.set('x-forwarded-host', req.headers.host)
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const upstream = await fetch(target, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: await readRawBuffer(req, maxBodyBytes) } : {}),
    redirect: 'manual',
    signal: controller.signal,
  })

  const outHeaders: Record<string, string | string[]> = {}
  const upstreamConnectionScoped = connectionNamed(upstream.headers.get('connection'))
  upstream.headers.forEach((value, name) => {
    // Drop content-encoding/length: fetch already decoded the body, so the
    // original values no longer match what we stream out. Skip set-cookie here
    // and re-attach the full list below — forEach yields each cookie separately,
    // so a single string slot would keep only the last one.
    if (
      HOP_BY_HOP.has(name) ||
      upstreamConnectionScoped.has(name) ||
      name === 'content-encoding' ||
      name === 'content-length' ||
      name === 'set-cookie'
    ) {
      return
    }
    outHeaders[name] = value
  })
  const setCookies = upstream.headers.getSetCookie()
  if (setCookies.length > 0) outHeaders['set-cookie'] = setCookies

  res.writeHead(upstream.status, outHeaders)
  if (!upstream.body) {
    res.end()
    return
  }
  try {
    // pipeline (unlike .pipe) propagates the stream's error instead of letting it
    // surface as an uncaught exception that would crash the whole proxy when the
    // upstream connection resets mid-body.
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch {
    res.destroy()
  }
}

// RFC 7230 §6.1: every header the Connection header names is hop-by-hop for
// that connection, so an intermediary must drop those too, not just the fixed
// set — otherwise `Connection: x-foo` smuggles x-foo past the static list.
function connectionNamed(header: string | null | undefined): Set<string> {
  const named = new Set<string>()
  if (!header) return named
  for (const token of header.split(',')) {
    const name = token.trim().toLowerCase()
    if (name !== '') named.add(name)
  }
  return named
}

/** Collapse Node's string | string[] header shape; duplicates join per RFC 9110 5.3. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

/**
 * Re-serialize a Cookie header without the named cookie; undefined if none
 * remain. A part is dropped exactly when core's readCookie would read it, so
 * the strip rule can never drift from the accept rule — a cookie the gate
 * accepted must never be the one forwarded to the origin.
 */
function stripCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  const kept = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && readCookie(part, name) === undefined)
  return kept.length > 0 ? kept.join('; ') : undefined
}
