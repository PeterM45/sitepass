import { createGate, type Gate, type GateOptions, type GateResult, readCookie } from './core'

/**
 * Shared plumbing for every adapter whose host speaks web Request/Response.
 * Internal: this module is deliberately not a package export — it is bundled
 * into the adapters' shared chunk. Like core, it uses only platform globals so
 * it runs unchanged on edge runtimes.
 */

// A login form body (next + password) is tiny; 64 KiB is generous headroom while
// keeping an unauthenticated POST to the login path from buffering without bound.
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

// The request header carrying the bypass credential. The reverse proxy's strip
// list must name exactly the header the adapters read, or the live credential
// would be forwarded to the origin — so every site shares this one constant.
export const BYPASS_HEADER = 'x-sitepass-bypass'

/** The options every adapter accepts: the gate options minus the env-sourced credentials. */
export type AdapterGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number | undefined
}

/**
 * Build a gate with credentials read from the adapter's environment. The env
 * var names and the empty-bypass normalization live here, once: an env reader
 * that returns '' counts as unset, so a blank SITEPASS_BYPASS_TOKEN can never
 * become a working bypass credential in any adapter.
 */
export function createGateFromEnv(
  options: Omit<GateOptions, 'password' | 'secret'>,
  readEnv: (name: 'SITEPASS_PASSWORD' | 'SITEPASS_SECRET' | 'SITEPASS_BYPASS_TOKEN') => string,
): Gate {
  return createGate({
    ...options,
    password: readEnv('SITEPASS_PASSWORD'),
    secret: readEnv('SITEPASS_SECRET'),
    bypassToken: options.bypassToken ?? (readEnv('SITEPASS_BYPASS_TOKEN') || undefined),
  })
}

/**
 * Run the gate against a web Request. Returns null when the request may pass —
 * the adapter then continues into its host — or the Response to send otherwise.
 */
export async function gateWebRequest(
  gate: Gate,
  request: Request,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Response | null> {
  const url = new URL(request.url)
  const isLoginPost = request.method.toUpperCase() === 'POST' && url.pathname === gate.loginPath

  let body: string | undefined
  if (isLoginPost) {
    const read = await readBodyCapped(request, maxBodyBytes)
    if (read === null) {
      // Fail closed on an oversized login body: an unauthenticated POST must
      // not buffer without bound, on any runtime.
      return new Response('Payload too large', {
        status: 413,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    body = read
  }

  const result = await gate.handle({
    method: request.method,
    path: url.pathname,
    search: url.search,
    cookie: readCookie(request.headers.get('cookie'), gate.cookieName),
    bypassToken: request.headers.get(BYPASS_HEADER) ?? undefined,
    body,
  })
  return toResponse(result)
}

/** Coerce an unknown env binding to a string; non-strings count as unset. */
export function envString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Translate a GateResult into a web Response; null means "pass". */
function toResponse(result: GateResult): Response | null {
  switch (result.type) {
    case 'pass':
      return null
    case 'redirect':
      return new Response(null, {
        status: 302,
        headers: { Location: result.location, 'Set-Cookie': result.setCookie },
      })
    case 'html':
      return new Response(result.body, { status: result.status, headers: result.headers })
  }
}

/** Read at most `limit` bytes of the body as text; null means it was larger. */
async function readBodyCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return ''
  // Read the stream incrementally rather than trusting Content-Length alone:
  // a chunked body has no declared length, and self-hosted runtimes (Bun,
  // @hono/node-server) impose no cap of their own.
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
