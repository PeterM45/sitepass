import type { IncomingMessage } from 'node:http'

/**
 * Capped body readers for the Node-side consumers (the Express adapter and the
 * reverse proxy). Internal: not a package export; bundled into their chunks.
 */

/** Thrown when a request body exceeds the byte limit; callers map it to 413. */
export class BodyTooLargeError extends Error {}

/** Read the raw body as UTF-8 text, rejecting with BodyTooLargeError over `limit`. */
export function readRawBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let done = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (done) return
      size += Buffer.byteLength(chunk)
      if (size > limit) {
        // Stop reading (cap the memory) but leave the socket alone so the caller
        // can still send a 413; pausing applies TCP backpressure to the uploader.
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

/** Read the raw body as bytes, rejecting with BodyTooLargeError over `limit`. */
export function readRawBuffer(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Uint8Array) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        req.pause()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) resolve(concat(chunks))
    })
    req.on('error', (error) => {
      if (!done) reject(error)
    })
  })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
