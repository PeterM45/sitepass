import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { createGate, type GateOptions, readCookie } from './core'
import { BodyTooLargeError, readRawBody } from './node-body'

export type ExpressGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number | undefined
}

// A login form body (next + password) is tiny; 64 KiB is generous headroom while
// keeping an unauthenticated POST to the login path from buffering without bound.
const DEFAULT_MAX_BODY_BYTES = 64 * 1024

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
export function gate({
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  ...options
}: ExpressGateOptions = {}): RequestHandler {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
    bypassToken: options.bypassToken ?? process.env.SITEPASS_BYPASS_TOKEN,
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

    // This promise must never reject: Express 4 does not route a rejected
    // middleware promise to error handlers, so a rethrow (e.g. a client
    // dropping the socket mid-login-body) would crash the process as an
    // unhandled rejection. Every failure goes to next(error) instead.
    try {
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
        bypassToken: headerValue(req.headers['x-sitepass-bypass']),
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
    } catch (error) {
      next(error)
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
