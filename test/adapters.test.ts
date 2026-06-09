import type { Server } from 'node:http'
import express from 'express'
import { Hono } from 'hono'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gate as astroGate } from '../src/astro'
import { gate as bunGate } from '../src/bun'
import { createGate, type GateOptions, readCookie } from '../src/core'
import { gate as expressGate } from '../src/express'
import { gate as honoGate } from '../src/hono'
import { gate as netlifyGate } from '../src/netlify'
import { gate as nextGate } from '../src/next'
import { gate as svelteGate } from '../src/sveltekit'
import { PASSWORD, SECRET } from './fixtures/credentials'

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

type AdapterOptions = Omit<GateOptions, 'password' | 'secret'> & { maxBodyBytes?: number }
type Drive = (path: string, init?: RequestInit) => Promise<Response>

/**
 * The conformance contract every adapter must satisfy. Each adapter supplies
 * only a driver factory (how to build the gate with options and feed it a
 * request) and, when a pass is not visible as a DOWNSTREAM body, a custom
 * pass assertion (Next signals pass via the x-middleware-next header).
 */
function describeAdapterConformance(
  name: string,
  makeDrive: (options?: AdapterOptions) => Drive | Promise<Drive>,
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

describeAdapterConformance('express', async (options) => {
  const app = express()
  app.use(expressGate(options))
  app.all('/{*path}', (_req, res) => {
    res.send('DOWNSTREAM')
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}`
  return (path, init) => fetch(`${base}${path}`, { ...init, redirect: 'manual' })
})

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
