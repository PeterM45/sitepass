import type { NextFunction, Request, Response } from 'express'
import { createGate, type GateOptions, readCookie } from './core'

/**
 * Express middleware adapter.
 *
 * Mount it before your routes (and before any body parser, since it reads the
 * raw login body off the request stream itself):
 *
 *   import { gate } from 'sitepass/express'
 *   app.use(gate())
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment.
 */
export type ExpressGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
}

// A login form body (next + password) is tiny; 64 KiB is generous headroom while
// keeping an unauthenticated POST to the login path from buffering without bound.
const DEFAULT_MAX_BODY_BYTES = 64 * 1024

// Thrown by readRawBody when the login body exceeds maxBodyBytes; mapped to 413.
class BodyTooLargeError extends Error {}

export function gate({
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  ...options
}: ExpressGateOptions = {}) {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
  })

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Derive path and search from originalUrl so the gate is correct regardless of
    // the mount point: req.path is mount-relative, so app.use('/x', gate()) would
    // make req.path "/y" for a request to "/x/y" and never match an absolute
    // loginPath like "/__gate".
    const queryAt = req.originalUrl.indexOf('?')
    const path = queryAt === -1 ? req.originalUrl : req.originalUrl.slice(0, queryAt)
    const search = queryAt === -1 ? '' : req.originalUrl.slice(queryAt)
    const isLoginPost = req.method.toUpperCase() === 'POST' && path === g.loginPath

    let body: string | undefined
    if (isLoginPost) {
      try {
        body = await readRawBody(req, maxBodyBytes)
      } catch (error) {
        // Fail closed on an oversized login body: never fall through to the gate
        // (or the app) with a partially read stream.
        if (error instanceof BodyTooLargeError) {
          res.status(413).type('text/plain').send('Payload too large')
          return
        }
        throw error
      }
    }

    const result = await g.handle({
      method: req.method,
      path,
      search,
      cookie: readCookie(req.headers.cookie, g.cookieName),
      body,
    })

    switch (result.type) {
      case 'pass':
        next()
        return
      case 'redirect':
        res.status(302).set('Location', result.location).set('Set-Cookie', result.setCookie).end()
        return
      case 'html':
        res.status(result.status).set(result.headers).send(result.body)
        return
    }
  }
}

// Read the raw request body directly so the adapter does not depend on
// express.urlencoded being mounted ahead of it. Capped at maxBodyBytes: an
// unauthenticated POST to the login path must not buffer an unbounded body.
function readRawBody(req: Request, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let done = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (done) return
      size += Buffer.byteLength(chunk)
      if (size > limit) {
        // Stop accumulating and apply TCP backpressure; the caller sends a 413.
        done = true
        req.pause()
        reject(new BodyTooLargeError())
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (!done) resolve(data)
    })
    req.on('error', (error) => {
      if (!done) reject(error)
    })
  })
}
