import type { Context, MiddlewareHandler } from 'hono'
import { createGate, type Gate, type GateOptions } from './core'
import { envString, gateWebRequest } from './web'

export type HonoGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
}

/**
 * Hono middleware adapter.
 *
 * Wire it up on your app, before the routes it guards:
 *
 *   import { gate } from 'sitepass/hono'
 *   app.use(gate())
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment. Env is read from
 * `c.env` (Cloudflare bindings) with a process.env fallback for Node and Bun.
 */
export function gate({ maxBodyBytes, ...options }: HonoGateOptions = {}): MiddlewareHandler {
  // c.env is only available per request, so build the gate on first use.
  let cached: Gate | undefined
  const gateFor = (c: Context) => {
    cached ??= createGate({
      ...options,
      password: readEnv(c, 'SITEPASS_PASSWORD'),
      secret: readEnv(c, 'SITEPASS_SECRET'),
    })
    return cached
  }

  return async (c, next) => {
    const response = await gateWebRequest(gateFor(c), c.req.raw, maxBodyBytes)
    if (!response) {
      await next()
      return
    }
    return response
  }
}

function readEnv(c: Context, name: string): string {
  const fromBindings = envString((c.env as Record<string, unknown> | undefined)?.[name])
  if (fromBindings !== '') return fromBindings
  // process is absent on Workers; guard so the fallback never throws there.
  return (typeof process !== 'undefined' ? process.env[name] : undefined) ?? ''
}
