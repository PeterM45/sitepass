import type { Server } from 'node:http'
import { connect } from 'node:net'
import express, { type ErrorRequestHandler } from 'express'
import { Hono } from 'hono'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gate as astroGate } from '../src/astro'
import { gate as bunGate } from '../src/bun'
import { createGate, readCookie } from '../src/core'
import { gate as expressGate } from '../src/express'
import { gate as honoGate } from '../src/hono'
import { config as netlifyConfig, gate as netlifyGate } from '../src/netlify'
import { gate as nextGate } from '../src/next'
import { gate as svelteGate } from '../src/sveltekit'
import type { AdapterGateOptions } from '../src/web'
import { PASSWORD, SECRET } from './fixtures/credentials'
import express4 from './fixtures/express4'

// Every adapter reads SITEPASS_* from the environment when gate() is called, so
// set them before any adapter is constructed. netlify reads a `Netlify` global.
process.env.SITEPASS_PASSWORD = PASSWORD
process.env.SITEPASS_SECRET = SECRET
;(globalThis as Record<string, unknown>).Netlify = {
  env: { get: (key: string) => process.env[key] },
}

const loginBody = `password=${encodeURIComponent(PASSWORD)}&next=/`
const BYPASS = 'ci-bypass-token-for-tests'

// A token minted by core with the shared secret is accepted by every adapter,
// since each adapter builds its gate with the same SITEPASS_SECRET.
let TOKEN: string
beforeAll(async () => {
  const res = await createGate({ password: PASSWORD, secret: SECRET }).handle({
    method: 'POST',
    path: '/__gate',
    body: loginBody,
  })
  if (res.type !== 'redirect') throw new Error(`mint failed: ${res.type}`)
  const token = readCookie(res.setCookie, 'gate')
  if (!token) throw new Error('no token minted')
  TOKEN = token
})

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init)
}

const postForm: RequestInit = {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: loginBody,
}

// astro/sveltekit handlers are typed to return Response | void; a pass on those
// returns next()/resolve()'s Response, so narrow (and assert) it is one.
function asResponse(value: unknown): Response {
  if (!(value instanceof Response)) throw new Error('expected a Response')
  return value
}

type Drive = (path: string, init?: RequestInit) => Promise<Response>

/**
 * The conformance contract every adapter must satisfy. Each adapter supplies
 * only a driver factory (how to build the gate with options and feed it a
 * request) and, when a pass is not visible as a DOWNSTREAM body, a custom
 * pass assertion (Next signals pass via the x-middleware-next header).
 */
function describeAdapterConformance(
  name: string,
  makeDrive: (options?: AdapterGateOptions) => Drive | Promise<Drive>,
  expectPass: (res: Response) => Promise<void> = async (res) => {
    expect(await res.text()).toBe('DOWNSTREAM')
  },
) {
  describe(`${name} adapter`, () => {
    let drive: Drive
    beforeAll(async () => {
      drive = await makeDrive()
    })

    it('serves the login page without a cookie', async () => {
      const res = await drive('/secret')
      expect(res.status).toBe(401)
      expect((await res.text()).toLowerCase()).toContain('password')
    })

    it('gates HEAD and OPTIONS like GET: 401 without a cookie', async () => {
      // Deliberate contract: bodiless verbs get the same 401 as GET. Notably a
      // CORS preflight OPTIONS to a gated API carries no cookie, so it receives
      // the 401 login response rather than reaching the app's CORS handler.
      for (const method of ['HEAD', 'OPTIONS']) {
        const res = await drive('/secret', { method })
        expect(res.status).toBe(401)
      }
    })

    it('passes through with a valid cookie', async () => {
      await expectPass(await drive('/secret', { headers: { cookie: `gate=${TOKEN}` } }))
    })

    it('mints a cookie on correct login that then passes', async () => {
      const res = await drive('/__gate', postForm)
      expect(res.status).toBe(302)
      const token = readCookie(res.headers.get('set-cookie'), 'gate')
      expect(token).toBeTruthy()
      await expectPass(await drive('/secret', { headers: { cookie: `gate=${token}` } }))
    })

    it('rejects an oversized login body with 413 instead of buffering it', async () => {
      // An unauthenticated POST to the login path must not buffer an unbounded
      // body; the default cap is 64 KiB, so a ~128 KiB body fails closed.
      const res = await drive('/__gate', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${'a'.repeat(128 * 1024)}`,
      })
      expect(res.status).toBe(413)
    })

    it('logout clears the session cookie and redirects', async () => {
      const res = await drive('/__gate/logout', { headers: { cookie: `gate=${TOKEN}` } })
      expect(res.status).toBe(302)
      expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    })

    it('lets a matching bypass token through and rejects a wrong one', async () => {
      const bypassed = await makeDrive({ bypassToken: BYPASS })
      await expectPass(await bypassed('/secret', { headers: { 'x-sitepass-bypass': BYPASS } }))
      const wrong = await bypassed('/secret', { headers: { 'x-sitepass-bypass': 'nope' } })
      expect(wrong.status).toBe(401)
    })
  })
}

const DOWNSTREAM = async () => new Response('DOWNSTREAM')

describeAdapterConformance(
  'next',
  (options) => {
    const handle = nextGate(options)
    return (path, init) =>
      handle(
        new NextRequest(
          `https://app.test${path}`,
          init as ConstructorParameters<typeof NextRequest>[1],
        ),
      )
  },
  async (res) => {
    expect(res.headers.get('x-middleware-next')).toBe('1')
  },
)

describeAdapterConformance('hono', (options) => {
  const app = new Hono()
  app.use(honoGate(options))
  app.all('*', (c) => c.text('DOWNSTREAM'))
  return async (path, init) => app.request(path, init)
})

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  )
})

async function listen(app: ReturnType<typeof express>): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

// peerDependencies claim express >=4, so the conformance suite runs both
// majors (via the express4 npm alias). Only the catch-all route syntax
// differs: Express 5 needs '/{*path}', Express 4 needs '*'.
for (const [name, createApp, allPath] of [
  ['express', express, '/{*path}'],
  ['express@4', express4, '*'],
] as const) {
  describeAdapterConformance(name, async (options) => {
    const app = createApp()
    app.use(expressGate(options))
    app.all(allPath, (_req, res) => {
      res.send('DOWNSTREAM')
    })
    const base = await listen(app)
    return (path, init) => fetch(`${base}${path}`, { ...init, redirect: 'manual' })
  })

  // Express 4 does not route a rejected middleware promise to error handlers:
  // the rejection becomes an unhandled rejection and Node kills the process.
  // So the adapter must never reject — failures (here: a client dropping the
  // socket mid-login-body) have to reach next(error) instead.
  describe(`${name} adapter error contract`, () => {
    it('routes an aborted login POST to next(error) without rejecting', async () => {
      const middleware = expressGate()
      const app = createApp()

      let sawRequest = () => {}
      const requestSeen = new Promise<void>((resolve) => {
        sawRequest = resolve
      })
      let report = (_outcome: { via: string; error: unknown }) => {}
      const settled = new Promise<{ via: string; error: unknown }>((resolve) => {
        report = resolve
      })

      app.use((req, res, next) => {
        sawRequest()
        // Observe the adapter's own promise: Express 5 masks a rejection by
        // routing it to error handlers itself, so asserting on next(error)
        // alone would not prove the Express-4-safe contract.
        void Promise.resolve(middleware(req, res, next)).catch((error) =>
          report({ via: 'rejection', error }),
        )
      })
      const onError: ErrorRequestHandler = (error, _req, res, _next) => {
        report({ via: 'next', error })
        res.status(500).end()
      }
      app.use(onError)

      const base = await listen(app)
      const { port } = new URL(base)

      // Raw socket login POST that promises 64 bytes, delivers a few, then drops.
      const socket = connect(Number(port), '127.0.0.1')
      socket.write(
        'POST /__gate HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/x-www-form-urlencoded\r\n' +
          'Content-Length: 64\r\n' +
          '\r\n' +
          'password=partial',
      )
      await requestSeen
      socket.destroy()

      const outcome = await settled
      expect(outcome.via).toBe('next')
      expect(outcome.error).toBeInstanceOf(Error)

      // The server survived the abort and still gates the next request.
      const res = await fetch(`${base}/secret`)
      expect(res.status).toBe(401)
    })
  })
}

describeAdapterConformance('bun', (options) => {
  const handle = bunGate(DOWNSTREAM, options)
  return (path, init) => handle(req(path, init))
})

describeAdapterConformance('astro', (options) => {
  const onRequest = astroGate(options)
  type Context = Parameters<typeof onRequest>[0]
  type Next = Parameters<typeof onRequest>[1]
  const next = DOWNSTREAM as unknown as Next
  return async (path, init) => {
    const context = {
      request: req(path, init),
      url: new URL(`https://app.test${path}`),
    } as unknown as Context
    return asResponse(await onRequest(context, next))
  }
})

describeAdapterConformance('sveltekit', (options) => {
  const handle = svelteGate(options)
  type HandleArg = Parameters<typeof handle>[0]
  const resolve = DOWNSTREAM as unknown as HandleArg['resolve']
  return async (path, init) => {
    const event = {
      request: req(path, init),
      url: new URL(`https://app.test${path}`),
    } as unknown as HandleArg['event']
    return asResponse(await handle({ event, resolve } as HandleArg))
  }
})

describeAdapterConformance('netlify', (options) => {
  const handle = netlifyGate(options)
  type Context = Parameters<typeof handle>[1]
  const ctx = { next: DOWNSTREAM } as Context
  return (path, init) => handle(req(path, init), ctx)
})

describe('hono adapter env sources', () => {
  it('prefers c.env bindings over process.env (the Workers path)', async () => {
    const app = new Hono()
    app.use(honoGate())
    app.all('*', (c) => c.text('DOWNSTREAM'))
    // process.env (set at the top of this file) holds different credentials, so
    // a login with the bindings password only succeeds if the bindings won.
    const bindings = { SITEPASS_PASSWORD: 'bindings-only-password', SITEPASS_SECRET: SECRET }
    const res = await app.request(
      '/__gate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent('bindings-only-password')}&next=/`,
      },
      bindings,
    )
    expect(res.status).toBe(302)
    expect(readCookie(res.headers.get('set-cookie'), 'gate')).toBeTruthy()
    // The process.env password no longer matches under bindings credentials.
    const wrong = await app.request('/__gate', postForm, bindings)
    expect(wrong.status).toBe(401)
  })
})

describe('netlify adapter outside the Edge runtime', () => {
  it('fails closed with the 503 not-configured page when the Netlify global is absent', async () => {
    const globals = globalThis as Record<string, unknown>
    const saved = globals.Netlify
    delete globals.Netlify
    try {
      const handle = netlifyGate()
      type Context = Parameters<typeof handle>[1]
      const res = await handle(req('/secret'), { next: DOWNSTREAM } as Context)
      expect(res.status).toBe(503)
    } finally {
      globals.Netlify = saved
    }
  })

  it('publishes config.path with its leading-slash literal type', () => {
    // Compile-time regression check: Netlify's Config types path as `/${string}`,
    // so a widened `string` here would break `export const config: Config = …`
    // in a consumer's typed edge function.
    const path: `/${string}` = netlifyConfig.path
    expect(path).toBe('/*')
  })
})
