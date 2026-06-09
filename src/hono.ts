import type { Context, MiddlewareHandler } from 'hono'
import type { Gate } from './core'
import { type AdapterGateOptions, createGateFromEnv, envString, gateWebRequest } from './web'

/** Options for `gate`: every gate option except the env-sourced credentials, plus `maxBodyBytes`. */
export type HonoGateOptions = AdapterGateOptions

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
    cached ??= createGateFromEnv(options, (name) => readEnv(c, name))
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
