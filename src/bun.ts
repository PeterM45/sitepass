import { createGate, type GateOptions } from './core'
import { gateWebRequest } from './web'

/**
 * The wrapped handler's shape. Generic over its rest arguments so handlers that
 * take Bun.serve's `server` parameter — e.g. the `server.upgrade(req)`
 * websocket pattern — keep their signature through the wrapper.
 */
export type FetchHandler<A extends unknown[] = unknown[]> = (
  request: Request,
  ...args: A
) => Response | Promise<Response>

export type BunGateOptions = Omit<GateOptions, 'password' | 'secret'> & {
  /** Max bytes read from the login POST body before responding 413. Default: 64 KiB. */
  maxBodyBytes?: number
}

/**
 * Bun.serve adapter. Wraps a fetch handler: the gate runs first, and on `pass`
 * the wrapped handler is called with all of its original arguments; otherwise
 * the gate's response is returned.
 *
 *   import { gate } from 'sitepass/bun'
 *   Bun.serve({ fetch: gate(myHandler) })
 *
 * Set SITEPASS_PASSWORD and SITEPASS_SECRET in the environment (Bun loads .env).
 */
export function gate<A extends unknown[]>(
  handler: FetchHandler<A>,
  { maxBodyBytes, ...options }: BunGateOptions = {},
): (request: Request, ...args: A) => Promise<Response> {
  const g = createGate({
    ...options,
    password: process.env.SITEPASS_PASSWORD ?? '',
    secret: process.env.SITEPASS_SECRET ?? '',
  })

  return async (request, ...args) =>
    (await gateWebRequest(g, request, maxBodyBytes)) ?? handler(request, ...args)
}
