/**
 * sitepass core: a framework-agnostic password gate.
 *
 * `createGate` returns a `handle(request)` that decides whether a request may
 * pass, must be redirected (after a successful login), or should receive an
 * HTML response (the login page or a misconfiguration notice). It never writes
 * a response itself — adapters translate the result into their host's types,
 * which is what keeps this file runnable unchanged on every modern runtime.
 *
 * Only Web Crypto and other platform globals are used here: no Node-only
 * imports, no byte buffers, no framework imports.
 */

export interface GateOptions {
  password: string
  secret: string
  /** Cookie name for the session token. Default: "gate". */
  cookieName?: string
  /** Session length in seconds. Default: 7 days. */
  sessionSeconds?: number
  /** Path that accepts the login POST and renders the login page. Default: "/__gate". */
  loginPath?: string
  /** Exact or path-prefix matches that bypass the gate. */
  publicPaths?: string[]
  /** When unconfigured, let traffic through instead of failing closed. Default: false. */
  failOpen?: boolean
  brand?: { title?: string; subtitle?: string; accent?: string }
}

export interface GateRequest {
  method: string
  /** Pathname only, e.g. "/pricing". */
  path: string
  /** "?ref=x" or "". */
  search?: string
  /** Current value of the gate cookie, if any. */
  cookie?: string
  /** Raw request body; only needed on the login POST. */
  body?: string
}

export type GateResult =
  | { type: 'pass' }
  | { type: 'redirect'; location: string; setCookie: string }
  | { type: 'html'; status: number; body: string; headers: Record<string, string> }

export interface Gate {
  handle(request: GateRequest): Promise<GateResult>
  /** Resolved cookie name, for adapters that read the request cookie. */
  cookieName: string
  /** Resolved login path, for adapters that need to recognize it. */
  loginPath: string
}

const DAY_SECONDS = 86400

const DEFAULT_BRAND = {
  title: 'Protected',
  subtitle: 'Enter the password to continue.',
  accent: '#4f46e5',
}

export function createGate(options: GateOptions): Gate {
  const cookieName = options.cookieName ?? 'gate'
  const sessionSeconds = options.sessionSeconds ?? 7 * DAY_SECONDS
  const loginPath = options.loginPath ?? '/__gate'
  const publicPaths = options.publicPaths ?? []
  const failOpen = options.failOpen ?? false
  const brand = {
    title: options.brand?.title ?? DEFAULT_BRAND.title,
    subtitle: options.brand?.subtitle ?? DEFAULT_BRAND.subtitle,
    accent: options.brand?.accent ?? DEFAULT_BRAND.accent,
  }
  const configured = options.password.length > 0 && options.secret.length > 0

  // Import the signing key once and reuse it. Lazy, so an unconfigured gate
  // never touches Web Crypto and a configured one pays the cost only on first use.
  let cachedKey: Promise<CryptoKey> | undefined
  const signingKey = () => {
    cachedKey ??= importHmacKey(options.secret)
    return cachedKey
  }

  async function handle(request: GateRequest): Promise<GateResult> {
    if (!configured) {
      // Fail closed by default: a missing password or secret must never silently
      // expose a site that was meant to be private.
      return failOpen ? { type: 'pass' } : notConfiguredPage()
    }

    if (isPublicPath(request.path, publicPaths)) {
      return { type: 'pass' }
    }

    if (request.method.toUpperCase() === 'POST' && request.path === loginPath) {
      return handleLogin(request)
    }

    if (await hasValidSession(request.cookie)) {
      return { type: 'pass' }
    }

    const next =
      request.path === loginPath ? '/' : sanitizeNext(request.path + (request.search ?? ''))
    return loginPage(401, next, false)
  }

  async function handleLogin(request: GateRequest): Promise<GateResult> {
    const form = new URLSearchParams(request.body ?? '')
    const next = sanitizeNext(form.get('next'))

    if (!(await isCorrectPassword(form.get('password') ?? ''))) {
      return loginPage(401, next, true)
    }

    const token = await signToken(await signingKey(), nowSeconds() + sessionSeconds)
    return { type: 'redirect', location: next, setCookie: sessionCookie(token, sessionSeconds) }
  }

  async function isCorrectPassword(submitted: string): Promise<boolean> {
    const key = await signingKey()
    // HMAC both sides and compare fixed-length digests in constant time, so the
    // check never leaks the password's length or content through timing.
    const [expected, actual] = await Promise.all([
      hmac(key, options.password),
      hmac(key, submitted),
    ])
    return timingSafeEqual(expected, actual)
  }

  async function hasValidSession(token: string | undefined): Promise<boolean> {
    if (!token) return false
    const expiry = await verifyToken(await signingKey(), token)
    return expiry !== null && expiry > nowSeconds()
  }

  function sessionCookie(token: string, maxAge: number): string {
    // HttpOnly: not readable from JS. Secure: HTTPS only. SameSite=Lax: the
    // cookie still rides the post-login redirect GET. Path=/: covers the whole site.
    return `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  }

  function loginPage(status: number, next: string, error: boolean): GateResult {
    return {
      type: 'html',
      status,
      body: renderLoginPage(brand, loginPath, next, error),
      headers: htmlHeaders(),
    }
  }

  function notConfiguredPage(): GateResult {
    return {
      type: 'html',
      status: 503,
      body: renderNotConfiguredPage(brand),
      headers: htmlHeaders(),
    }
  }

  return { handle, cookieName, loginPath }
}

/** Read a single named cookie from a raw Cookie header. */
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

function htmlHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
}

function isPublicPath(path: string, publicPaths: string[]): boolean {
  return publicPaths.some((entry) => {
    // Match on whole path segments so "/api/webhooks" covers "/api/webhooks/stripe"
    // but not "/apixyz".
    const base = entry.endsWith('/') ? entry.slice(0, -1) : entry
    return path === base || path.startsWith(`${base}/`)
  })
}

/**
 * Reduce a value to a safe, same-origin request path or "/". Used for the login
 * `next` redirect and reused by the reverse proxy to keep a crafted request line
 * from choosing the forward target's host.
 */
export function sanitizeNext(value: string | null | undefined): string {
  // Accept only same-site absolute paths. An absolute URL, a protocol-relative
  // "//host", or a "/\host" (which browsers treat as absolute) would let a crafted
  // `next` bounce a freshly logged-in visitor to another origin.
  if (value?.[0] !== '/') return '/'
  if (value[1] === '/' || value[1] === '\\') return '/'
  // Control characters (CR/LF) in `next` could inject extra headers via Location.
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return '/'
  }
  return value
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// --- Stateless session token: base64url(expiry) "." base64url(HMAC(expiry)) ---

const encoder = new TextEncoder()

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

async function signToken(key: CryptoKey, expiry: number): Promise<string> {
  const payload = String(expiry)
  const signature = await hmac(key, payload)
  return `${base64urlEncode(encoder.encode(payload))}.${base64urlEncode(signature)}`
}

/** Returns the encoded expiry if the signature is authentic, otherwise null. */
async function verifyToken(key: CryptoKey, token: string): Promise<number | null> {
  const dot = token.indexOf('.')
  if (dot === -1) return null

  let payloadBytes: Uint8Array
  let signature: Uint8Array
  try {
    payloadBytes = base64urlDecode(token.slice(0, dot))
    signature = base64urlDecode(token.slice(dot + 1))
  } catch {
    return null
  }
  if (signature.length !== 32) return null

  const payload = new TextDecoder().decode(payloadBytes)
  const expected = await hmac(key, payload)
  // Constant-time: a forged signature must not be distinguishable by timing.
  if (!timingSafeEqual(expected, signature)) return null

  const expiry = Number(payload)
  return Number.isSafeInteger(expiry) ? expiry : null
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Comparing lengths first is safe: HMAC tags are a fixed 32 bytes, so the
  // length reveals nothing about the secret.
  if (a.length !== b.length) return false
  let diff = 0
  // XOR every byte and OR the results; never return early on a mismatch.
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// --- Self-contained HTML (no external assets, no client JavaScript) ---

type Brand = { title: string; subtitle: string; accent: string }

function renderLoginPage(brand: Brand, loginPath: string, next: string, error: boolean): string {
  const errorNotice = error
    ? '<p class="error" role="alert">Incorrect password. Try again.</p>'
    : ''
  const inner = `<h1>${escapeHtml(brand.title)}</h1>
      <p class="subtitle">${escapeHtml(brand.subtitle)}</p>
      <form method="post" action="${escapeHtml(loginPath)}">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="sitepass-password">Password</label>
        <input id="sitepass-password" name="password" type="password" autocomplete="current-password" autofocus required />
        ${errorNotice}
        <button type="submit">Continue</button>
      </form>`
  return documentShell(brand.title, brand.accent, inner)
}

function renderNotConfiguredPage(brand: Brand): string {
  const inner = `<h1>Not configured</h1>
      <p class="subtitle">This site is gated by sitepass, but the password or secret is not set, so the gate is failing closed. Set them and reload.</p>`
  return documentShell('Not configured', brand.accent, inner)
}

function documentShell(title: string, accent: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)}</title>
    <style>${pageStyles(accent)}</style>
  </head>
  <body>
    <main class="card">
      ${inner}
    </main>
  </body>
</html>`
}

function pageStyles(accent: string): string {
  return `
    :root { --accent: ${accent}; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #18181b; background: #f4f4f5;
    }
    .card {
      width: 100%; max-width: 22rem; padding: 2rem; background: #fff; border-radius: 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 10px 30px rgba(0,0,0,.08);
    }
    h1 { margin: 0 0 .35rem; font-size: 1.4rem; }
    .subtitle { margin: 0 0 1.5rem; color: #6b7280; font-size: .95rem; line-height: 1.5; }
    label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .4rem; }
    input[type=password] {
      width: 100%; padding: .7rem .8rem; font-size: 1rem; color: inherit; background: #fff;
      border: 1px solid #d4d4d8; border-radius: 8px;
    }
    input[type=password]:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .error { margin: .75rem 0 0; color: #dc2626; font-size: .85rem; }
    button {
      width: 100%; margin-top: 1.25rem; padding: .7rem; font-size: 1rem; font-weight: 600;
      color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
    }
    button:hover { filter: brightness(.95); }
    @media (prefers-color-scheme: dark) {
      body { color: #e4e4e7; background: #09090b; }
      .card { background: #18181b; box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.5); }
      .subtitle { color: #a1a1aa; }
      input[type=password] { color: #e4e4e7; background: #27272a; border-color: #3f3f46; }
    }`
}
