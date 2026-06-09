// sitepass core: a framework-agnostic password gate.
//
// createGate returns a handle(request) that decides whether a request may pass,
// must be redirected (after a successful login), or should receive an HTML
// response (the login page or a misconfiguration notice). It never writes a
// response itself — adapters translate the result into their host's types,
// which is what keeps this file runnable unchanged on every modern runtime.
//
// Only Web Crypto and other platform globals are used here: no Node-only
// imports, no byte buffers, no framework imports.

import { renderDefaultLoginPage, renderNotConfiguredPage } from './login-page'

// escapeHtml lives with the pages it protects; re-exported here because custom
// `renderLoginPage` implementations import it from the package root.
export { escapeHtml } from './login-page'

/** Options for `createGate`. Only `password` and `secret` are required. */
export interface GateOptions {
  /** The shared password visitors type. Empty means unconfigured: the gate fails closed. */
  password: string
  /**
   * Signs every session token. Use a random value of at least 16 characters
   * (32+ bytes recommended); anything shorter counts as unconfigured and the
   * gate fails closed. Rotating it invalidates all outstanding sessions.
   */
  secret: string
  /** Cookie name for the session token. Default: "gate". */
  cookieName?: string | undefined
  /** Session length in seconds. Default: 7 days. */
  sessionSeconds?: number | undefined
  /** Path that accepts the login POST and renders the login page. Default: "/__gate". */
  loginPath?: string | undefined
  /** Exact or path-prefix matches that bypass the gate. Default: []. */
  publicPaths?: readonly string[] | undefined
  /** When unconfigured, let traffic through instead of failing closed. Default: false. */
  failOpen?: boolean | undefined
  /**
   * When set, a request whose `bypassToken` matches passes without a session.
   * Lets CI jobs, E2E runs, and uptime monitors through the gate: adapters read
   * it from the `x-sitepass-bypass` header (and the SITEPASS_BYPASS_TOKEN
   * environment variable). Compared in constant time.
   */
  bypassToken?: string | undefined
  /**
   * Emit the cookie's `Secure` attribute. Default: true. Only set this to false
   * for plain-HTTP deployments (e.g. a LAN-only site behind the reverse proxy);
   * without `Secure` the session token travels on unencrypted connections.
   */
  cookieSecure?: boolean | undefined
  /**
   * Called when a login attempt fails (wrong password). Fire-and-forget, and
   * receives only a redacted `{ method, path }` view — never the submitted
   * password or the session cookie — so wiring it to logs can't persist
   * credentials.
   */
  onAuthFailure?: ((info: AuthFailure) => void) | undefined
  /**
   * Replace the built-in login page. The returned HTML must POST the form to
   * `loginPath` with a `password` input and a hidden `next` input carrying the
   * given value, or logins will stop working. Escape `next` when interpolating.
   */
  renderLoginPage?:
    | ((context: {
        loginPath: string
        next: string
        error: boolean
        brand: { title: string; subtitle: string; accent: string }
      }) => string)
    | undefined
  /** Login page branding. Defaults: "Protected" / "Enter the password to continue." */
  brand?:
    | {
        title?: string | undefined
        subtitle?: string | undefined
        /**
         * Accent color for the default page. Accepts hex, named, or rgb()/hsl()
         * functional CSS colors; anything else silently falls back to #4f46e5.
         */
        accent?: string | undefined
      }
    | undefined
}

/** Redacted view of a failed login, passed to `onAuthFailure`. */
export interface AuthFailure {
  method: string
  /** Pathname only, e.g. "/__gate". */
  path: string
}

/** A host request normalized to the fields the gate inspects. Adapters build one per request. */
export interface GateRequest {
  /** HTTP method, any case. */
  method: string
  /** Pathname only, e.g. "/pricing". */
  path: string
  /** "?ref=x" or "". */
  search?: string | undefined
  /** Current value of the gate cookie, if any. */
  cookie?: string | undefined
  /** Value of the `x-sitepass-bypass` header, if any. */
  bypassToken?: string | undefined
  /** Raw request body; only needed on the login POST. */
  body?: string | undefined
}

/**
 * The gate's decision for one request. `pass`: let it through to the app.
 * `redirect`: send a 302 to `location` with the `setCookie` value (a login or
 * logout). `html`: send the page as-is — the login page or the 503
 * not-configured notice.
 */
export type GateResult =
  | { type: 'pass' }
  | { type: 'redirect'; location: string; setCookie: string }
  | { type: 'html'; status: number; body: string; headers: Record<string, string> }

/** The gate built by `createGate`. Adapters call `handle` once per request. */
export interface Gate {
  /** Decide pass / redirect / html for one normalized request. */
  handle(request: GateRequest): Promise<GateResult>
  /** Resolved cookie name, for adapters that read the request cookie. */
  readonly cookieName: string
  /** Resolved login path, for adapters that need to recognize it. */
  readonly loginPath: string
}

const DAY_SECONDS = 86400

// Below this, the HMAC key is guessable enough that a single captured token
// invites an offline brute force; treat the gate as unconfigured instead.
const MIN_SECRET_LENGTH = 16

const DEFAULT_BRAND = {
  title: 'Protected',
  subtitle: 'Enter the password to continue.',
  accent: '#4f46e5',
}

/**
 * Build a password gate. Pass `password` and `secret` (from the environment,
 * never hardcoded) plus any options; the returned gate's `handle(request)`
 * decides pass / redirect / html for each request. Used directly only when
 * writing a custom adapter — the shipped adapters call this for you.
 */
export function createGate(options: GateOptions): Gate {
  const cookieName = options.cookieName ?? 'gate'
  // Guard against a non-finite or fractional session length: NaN, Infinity, or
  // a fraction (e.g. a value computed by division) would mint a token whose
  // stringified expiry never validates — a silent login loop. Flooring matches
  // the nowSeconds convention. A finite negative just yields an already-expired
  // token, which verifyToken handles correctly; the CLI separately rejects
  // non-positive.
  const requestedSeconds = options.sessionSeconds ?? 7 * DAY_SECONDS
  const sessionSeconds = Number.isFinite(requestedSeconds)
    ? Math.floor(requestedSeconds)
    : 7 * DAY_SECONDS
  const loginPath = options.loginPath ?? '/__gate'
  const logoutPath = `${loginPath}/logout`
  const publicPaths = options.publicPaths ?? []
  const failOpen = options.failOpen ?? false
  const cookieSecure = options.cookieSecure ?? true
  const brand = {
    title: options.brand?.title ?? DEFAULT_BRAND.title,
    subtitle: options.brand?.subtitle ?? DEFAULT_BRAND.subtitle,
    accent: safeAccent(options.brand?.accent ?? DEFAULT_BRAND.accent),
  }
  const configured = options.password.length > 0 && options.secret.length >= MIN_SECRET_LENGTH

  // Import the signing key once and reuse it. Lazy, so an unconfigured gate
  // never touches Web Crypto and a configured one pays the cost only on first use.
  let cachedKey: Promise<CryptoKey> | undefined
  const signingKey = () => {
    cachedKey ??= importHmacKey(options.secret)
    return cachedKey
  }

  // A digest of the password is mixed into every token's signed message, so
  // rotating the password (not just the secret) invalidates outstanding sessions.
  let cachedTag: Promise<string> | undefined
  const passwordTag = () => {
    cachedTag ??= signingKey()
      .then((key) => hmac(key, options.password))
      .then(base64urlEncode)
    return cachedTag
  }

  async function handle(request: GateRequest): Promise<GateResult> {
    if (!configured) {
      // Fail closed by default: a missing password or secret must never silently
      // expose a site that was meant to be private.
      return failOpen ? { type: 'pass' } : notConfiguredPage()
    }

    // The login POST and logout are checked before publicPaths: these paths are
    // intrinsically the gate's own, so a publicPaths entry that happens to
    // cover them must not swallow the request and make login impossible.
    if (request.method.toUpperCase() === 'POST' && request.path === loginPath) {
      return handleLogin(request)
    }

    // GET (a logout link) or POST (a logout form). Restricting the method keeps
    // logout from shadowing an unrelated consumer route on other verbs, and
    // narrows the forced-logout surface (SameSite=Lax already blocks the
    // cross-site subresource case).
    if (request.path === logoutPath && ['GET', 'POST'].includes(request.method.toUpperCase())) {
      return { type: 'redirect', location: '/', setCookie: sessionCookie('', 0) }
    }

    if (isPublicPath(request.path, publicPaths)) {
      return { type: 'pass' }
    }

    if (request.bypassToken !== undefined && (await isCorrectBypass(request.bypassToken))) {
      return { type: 'pass' }
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
      try {
        // Redacted on purpose: the hook must never see the submitted password
        // or the session cookie, since it is the natural place to wire logging.
        options.onAuthFailure?.({ method: request.method, path: request.path })
      } catch {
        // A throwing observer must not turn a failed login into a crash.
      }
      return loginPage(401, next, true)
    }

    const token = await signToken(
      await signingKey(),
      nowSeconds() + sessionSeconds,
      await passwordTag(),
    )
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

  async function isCorrectBypass(submitted: string): Promise<boolean> {
    if (!options.bypassToken) return false
    const key = await signingKey()
    // Same shape as the password check: constant time, no length leak.
    const [expected, actual] = await Promise.all([
      hmac(key, options.bypassToken),
      hmac(key, submitted),
    ])
    return timingSafeEqual(expected, actual)
  }

  async function hasValidSession(token: string | undefined): Promise<boolean> {
    if (!token) return false
    const expiry = await verifyToken(await signingKey(), token, await passwordTag())
    return expiry !== null && expiry > nowSeconds()
  }

  function sessionCookie(token: string, maxAge: number): string {
    // HttpOnly: not readable from JS. Secure: HTTPS only. SameSite=Lax: the
    // cookie still rides the post-login redirect GET. Path=/: covers the whole site.
    const secure = cookieSecure ? ' Secure;' : ''
    return `${cookieName}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`
  }

  function loginPage(status: number, next: string, error: boolean): GateResult {
    const body = options.renderLoginPage
      ? options.renderLoginPage({ loginPath, next, error, brand })
      : renderDefaultLoginPage(brand, loginPath, next, error)
    return { type: 'html', status, body, headers: htmlHeaders() }
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

function isPublicPath(path: string, publicPaths: readonly string[]): boolean {
  // The path is matched verbatim, before any percent-decoding. A percent-encoded
  // separator can smuggle traversal past a literal prefix (e.g.
  // "/assets/..%2f..%2fsecret" matches a "/assets/" prefix yet a decoding origin
  // resolves it elsewhere). Reject any encoded dot (%2e), slash (%2f), backslash
  // (%5c), semicolon (%3b, which an origin may decode into a "..;" path-parameter
  // traversal), or a stray percent (%25 and friends, which a double-decoding
  // origin could unwrap into one of the above). Real public asset paths contain
  // none of these, so treat such a path as non-public and fall through to the gate.
  if (/%(2[ef]|5c|3b|25)/i.test(path)) return false
  // Same idea for literal dot-segments, backslashes, and path-parameter (";")
  // segments: the edge adapters hand over a URL-normalized pathname, but the
  // reverse proxy and Express pass the raw request target, where "/assets/../secret"
  // matches an "/assets" prefix verbatim yet resolves elsewhere at the origin.
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(';')) {
      return false
    }
  }
  return publicPaths.some((entry) => {
    // "/" must stay an exact match on the root: stripping its trailing slash
    // would leave an empty base whose prefix check matches every path and
    // silently un-gates the whole site. Empty entries are ignored outright.
    if (entry === '') return false
    if (entry === '/') return path === '/'
    // Match on whole path segments so "/api/webhooks" covers "/api/webhooks/stripe"
    // but not "/api/webhooksxyz".
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

// The accent is interpolated into a <style> block, where escapeHtml does not
// help: a value like "red; } </style><script>…" would close the declaration, the
// rule, and the element. Accept only well-formed CSS colors (hex, named, or
// rgb/hsl functional) — none of which can contain <, ;, {, }, or quotes — and
// fall back to the default for anything else.
function safeAccent(accent: string): string {
  const value = accent.trim()
  const hex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
  const named = /^[a-z]+$/i
  const functional = /^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i
  return hex.test(value) || named.test(value) || functional.test(value)
    ? value
    : DEFAULT_BRAND.accent
}

// --- Stateless session token: base64url(expiry) "." base64url(HMAC(expiry "." passwordTag)) ---
// The password tag rides inside the signed message (not the token), so the
// token stays the same size while a password rotation invalidates it.

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

async function signToken(key: CryptoKey, expiry: number, passwordTag: string): Promise<string> {
  const payload = String(expiry)
  const signature = await hmac(key, `${payload}.${passwordTag}`)
  return `${base64urlEncode(encoder.encode(payload))}.${base64urlEncode(signature)}`
}

/** Returns the encoded expiry if the signature is authentic, otherwise null. */
async function verifyToken(
  key: CryptoKey,
  token: string,
  passwordTag: string,
): Promise<number | null> {
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
  const expected = await hmac(key, `${payload}.${passwordTag}`)
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
  // XOR every byte and OR the results; never return early on a mismatch. The
  // lengths are equal, so b[i] always exists — "?? 0" only satisfies the checker.
  for (const [i, byte] of a.entries()) diff |= byte ^ (b[i] ?? 0)
  return diff === 0
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
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
