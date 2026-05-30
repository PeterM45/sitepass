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
export function gate(options: Omit<GateOptions, 'password' | 'secret'> = {}) {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
  })

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const queryAt = req.originalUrl.indexOf('?')
    const search = queryAt === -1 ? '' : req.originalUrl.slice(queryAt)
    const isLoginPost = req.method.toUpperCase() === 'POST' && req.path === g.loginPath

    const result = await g.handle({
      method: req.method,
      path: req.path,
      search,
      cookie: readCookie(req.headers.cookie, g.cookieName),
      body: isLoginPost ? await readRawBody(req) : undefined,
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
// express.urlencoded being mounted ahead of it.
function readRawBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
