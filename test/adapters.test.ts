import type { Server } from 'node:http'
import express from 'express'
import { Hono } from 'hono'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gate as astroGate } from '../src/astro'
import { gate as bunGate } from '../src/bun'
import { createGate, readCookie } from '../src/core'
import { gate as expressGate } from '../src/express'
import { gate as honoGate } from '../src/hono'
import { gate as netlifyGate } from '../src/netlify'
import { gate as nextGate } from '../src/next'
import { gate as svelteGate } from '../src/sveltekit'

// Every adapter reads SITEPASS_* from the environment when gate() is called, so
// set them before any adapter is constructed. netlify reads a `Netlify` global.
const PASSWORD = 'correct horse battery staple'
const SECRET = 'a-test-secret-that-is-plenty-long-1234567890'
process.env.SITEPASS_PASSWORD = PASSWORD
process.env.SITEPASS_SECRET = SECRET
;(globalThis as Record<string, unknown>).Netlify = {
  env: { get: (key: string) => process.env[key] },
}

const loginBody = `password=${encodeURIComponent(PASSWORD)}&next=/`

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

describe('next adapter', () => {
  const handle = nextGate()
  // NextRequest uses Next's own RequestInit (signal cannot be null), so type the
  // init against the constructor rather than the global RequestInit.
  type NextInit = ConstructorParameters<typeof NextRequest>[1]
  const nreq = (path: string, init?: NextInit) => new NextRequest(`https://app.test${path}`, init)
  const nextLogin: NextInit = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: loginBody,
  }

  it('serves the login page without a cookie', async () => {
    const res = await handle(nreq('/secret'))
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = await handle(nreq('/secret', { headers: { cookie: `gate=${TOKEN}` } }))
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = await handle(nreq('/__gate', nextLogin))
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = await handle(nreq('/secret', { headers: { cookie: `gate=${token}` } }))
    expect(pass.headers.get('x-middleware-next')).toBe('1')
  })
})

describe('hono adapter', () => {
  const app = new Hono()
  app.use(honoGate())
  app.all('*', (c) => c.text('DOWNSTREAM'))

  it('serves the login page without a cookie', async () => {
    const res = await app.request('/secret')
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = await app.request('/secret', { headers: { cookie: `gate=${TOKEN}` } })
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = await app.request('/__gate', postForm)
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = await app.request('/secret', { headers: { cookie: `gate=${token}` } })
    expect(await pass.text()).toBe('DOWNSTREAM')
  })
})

describe('express adapter', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    const app = express()
    app.use(expressGate())
    app.get('/secret', (_req, res) => {
      res.send('DOWNSTREAM')
    })
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${address.port}`
  })
  afterAll(() => server?.close())

  it('serves the login page without a cookie', async () => {
    const res = await fetch(`${base}/secret`, { redirect: 'manual' })
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = await fetch(`${base}/secret`, { headers: { cookie: `gate=${TOKEN}` } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = await fetch(`${base}/__gate`, { ...postForm, redirect: 'manual' })
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = await fetch(`${base}/secret`, { headers: { cookie: `gate=${token}` } })
    expect(await pass.text()).toBe('DOWNSTREAM')
  })

  it('rejects an oversized login body with 413 instead of buffering it', async () => {
    // An unauthenticated POST to the login path must not buffer an unbounded body;
    // the default cap is 64 KiB, so a ~128 KiB body fails closed with 413.
    const huge = `password=${'a'.repeat(128 * 1024)}`
    const res = await fetch(`${base}/__gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: huge,
      redirect: 'manual',
    })
    expect(res.status).toBe(413)
  })
})

describe('bun adapter', () => {
  const handle = bunGate(async () => new Response('DOWNSTREAM'))

  it('serves the login page without a cookie', async () => {
    const res = await handle(req('/secret'))
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = await handle(req('/secret', { headers: { cookie: `gate=${TOKEN}` } }))
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = await handle(req('/__gate', postForm))
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = await handle(req('/secret', { headers: { cookie: `gate=${token}` } }))
    expect(await pass.text()).toBe('DOWNSTREAM')
  })
})

describe('astro adapter', () => {
  const onRequest = astroGate()
  type Context = Parameters<typeof onRequest>[0]
  type Next = Parameters<typeof onRequest>[1]
  const next = (async () => new Response('DOWNSTREAM')) as unknown as Next
  const ctx = (path: string, init?: RequestInit, cookie?: string): Context =>
    ({
      request: req(path, init),
      url: new URL(`https://app.test${path}`),
      cookies: {
        get: (name: string) => (cookie && name === 'gate' ? { value: cookie } : undefined),
      },
    }) as unknown as Context

  it('serves the login page without a cookie', async () => {
    const res = asResponse(await onRequest(ctx('/secret'), next))
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = asResponse(await onRequest(ctx('/secret', undefined, TOKEN), next))
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = asResponse(await onRequest(ctx('/__gate', postForm), next))
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = asResponse(await onRequest(ctx('/secret', undefined, token ?? ''), next))
    expect(await pass.text()).toBe('DOWNSTREAM')
  })
})

describe('sveltekit adapter', () => {
  const handle = svelteGate()
  type HandleArg = Parameters<typeof handle>[0]
  const resolve = (async () => new Response('DOWNSTREAM')) as unknown as HandleArg['resolve']
  const event = (path: string, init?: RequestInit, cookie?: string): HandleArg =>
    ({
      event: {
        request: req(path, init),
        url: new URL(`https://app.test${path}`),
        cookies: { get: (name: string) => (cookie && name === 'gate' ? cookie : undefined) },
      },
      resolve,
    }) as unknown as HandleArg

  it('serves the login page without a cookie', async () => {
    const res = asResponse(await handle(event('/secret')))
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = asResponse(await handle(event('/secret', undefined, TOKEN)))
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = asResponse(await handle(event('/__gate', postForm)))
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = asResponse(await handle(event('/secret', undefined, token ?? '')))
    expect(await pass.text()).toBe('DOWNSTREAM')
  })
})

describe('netlify adapter', () => {
  const handle = netlifyGate()
  type NetlifyContext = Parameters<typeof handle>[1]
  const ctx = (cookie?: string): NetlifyContext =>
    ({
      next: async () => new Response('DOWNSTREAM'),
      cookies: { get: (name: string) => (cookie && name === 'gate' ? cookie : undefined) },
    }) as unknown as NetlifyContext

  it('serves the login page without a cookie', async () => {
    const res = await handle(req('/secret'), ctx())
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain('password')
  })

  it('passes through with a valid cookie', async () => {
    const res = await handle(req('/secret'), ctx(TOKEN))
    expect(await res.text()).toBe('DOWNSTREAM')
  })

  it('mints a cookie on correct login that then passes', async () => {
    const res = await handle(req('/__gate', postForm), ctx())
    expect(res.status).toBe(302)
    const token = readCookie(res.headers.get('set-cookie'), 'gate')
    expect(token).toBeTruthy()
    const pass = await handle(req('/secret'), ctx(token ?? ''))
    expect(await pass.text()).toBe('DOWNSTREAM')
  })
})
