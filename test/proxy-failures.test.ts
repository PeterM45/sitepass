import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PASSWORD, SECRET } from './fixtures/credentials'
import { closeAll, listen, loginCookie, proxy } from './fixtures/proxy-helpers'

// The proxy's failure modes: origin down, bodiless upstream responses, and the
// teardown paths around a client that disappears mid-request. These pin the
// catch handler in startProxy and the bodiless early-return in forward.

afterEach(closeAll)

describe('reverse proxy failure modes', () => {
  it('answers 502 Bad gateway with Connection: close when the origin is down', async () => {
    const { server: origin, port: originPort } = await listen((_req, res) => res.end('OK'))
    const port = await proxy({
      origin: `http://127.0.0.1:${originPort}`,
      password: PASSWORD,
      secret: SECRET,
    })
    const token = await loginCookie(port)
    // Take the origin down only after login, so the forward hits a dead port.
    await new Promise((resolve) => origin.close(resolve))

    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('Bad gateway')
    expect(res.headers.get('connection')).toBe('close')
  })

  it('completes a HEAD request instead of hanging on the bodiless response', async () => {
    const origin = await listen((req, res) => {
      res.writeHead(200, { 'x-method': req.method ?? '' })
      res.end()
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'HEAD',
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-method')).toBe('HEAD')
    expect(await res.text()).toBe('')
  })

  it('relays a bodiless 204 upstream response without hanging', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    const token = await loginCookie(port)
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { cookie: `gate=${token}` },
    })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('tears down quietly when the client drops mid-upload, then keeps serving', async () => {
    const origin = await listen((_req, res) => res.end('OK'))
    const port = await proxy({
      origin: `http://127.0.0.1:${origin.port}`,
      password: PASSWORD,
      secret: SECRET,
    })

    // Announce a large login body, send a fragment, then drop the socket: the
    // body read rejects with the response already gone, so the catch handler
    // must take the no-reply teardown path instead of writing a 413/502.
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `POST /__gate HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: 5000\r\n\r\npassword=',
        )
        // Give the proxy a beat to start reading the body before the cut.
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 50)
      })
    })

    // Proof of life: the proxy still answers (gate-served 401, origin untouched).
    const live = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    expect(live.status).toBe(401)
  })
})
