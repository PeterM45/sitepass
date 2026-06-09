import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BodyTooLargeError, readRawBody, readRawBuffer } from '../src/node-body'

// A minimal stand-in for an http.IncomingMessage: an EventEmitter plus the two
// methods the readers call. `req` is the typed view passed to the readers;
// `emit`/`emitData` drive end/error/aborted/close deterministically.
function fakeReq() {
  const emitter = Object.assign(new EventEmitter(), {
    setEncoding() {},
    pause() {},
  })
  return {
    req: emitter as unknown as IncomingMessage,
    emit: (event: string, arg?: unknown) => emitter.emit(event, arg),
    emitData: (chunk: string | Uint8Array) => emitter.emit('data', chunk),
  }
}

describe('readRawBody', () => {
  it('resolves with the full body on end', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBody(req, 1024)
    emitData('hello ')
    emitData('world')
    emit('end')
    expect(await promise).toBe('hello world')
  })

  it('rejects with BodyTooLargeError over the limit', async () => {
    const { req, emitData } = fakeReq()
    const promise = readRawBody(req, 4)
    emitData('toolong')
    await expect(promise).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('rejects (does not hang) when the client aborts mid-upload', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBody(req, 1024)
    emitData('partial')
    emit('aborted')
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it('rejects when the socket closes before end', async () => {
    const { req, emit } = fakeReq()
    const promise = readRawBody(req, 1024)
    emit('close')
    await expect(promise).rejects.toThrow(/closed/)
  })

  it('a close after a normal end does not reject (resolve wins)', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBody(req, 1024)
    emitData('done')
    emit('end')
    emit('close')
    expect(await promise).toBe('done')
  })

  it('rejects with the socket error itself on a mid-read error (e.g. ECONNRESET)', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBody(req, 1024)
    emitData('partial')
    const boom = new Error('read ECONNRESET')
    emit('error', boom)
    await expect(promise).rejects.toBe(boom)
  })

  it('an error after a normal end does not reject (resolve wins)', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBody(req, 1024)
    emitData('done')
    emit('end')
    emit('error', new Error('late socket error'))
    expect(await promise).toBe('done')
  })
})

describe('readRawBuffer', () => {
  it('resolves with the concatenated bytes on end', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBuffer(req, 1024)
    emitData(new Uint8Array([1, 2]))
    emitData(new Uint8Array([3]))
    emit('end')
    expect([...(await promise)]).toEqual([1, 2, 3])
  })

  it('rejects (does not hang) when the client aborts mid-upload', async () => {
    const { req, emit, emitData } = fakeReq()
    const promise = readRawBuffer(req, 1024)
    emitData(new Uint8Array([1]))
    emit('aborted')
    await expect(promise).rejects.toThrow(/aborted/)
  })
})
