/**
 * Detail-image transport: the Webview's scoped route matcher, the base64
 * helpers on both sides, and the Host's opt-in binary answer path. The Webview
 * DOM resolver itself is exercised only by the extension build, so these tests
 * drive the pure helpers and the bridge protocol they use.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  encodeBase64,
  MAX_BINARY_RESPONSE_BYTES,
  readBoundedBody,
  WebviewBridge,
} from '../src/host/bridge.ts'
import { decodeBase64, detailImageRoute, MAX_DETAIL_IMAGE_BYTES } from '../src/webview/main.ts'

/** Appended paths are ASCII only, so the base URI needs no escaping. */
const BASE_URI = 'vscode-webview://webview/index.html'

/** Bytes of a PNG signature plus one non-UTF-8 value. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

interface Frame {
  readonly type?: string
  readonly id?: number
  readonly status?: number
  readonly body?: string
  readonly base64?: string
  readonly contentType?: string
}

interface Harness {
  readonly bridge: WebviewBridge
  readonly frames: Frame[]
  readonly requests: Request[]
}

function harness(respond: (request: Request) => Promise<Response>): Harness {
  const frames: Frame[] = []
  const requests: Request[] = []
  const ctx = {
    get: (name: string) => {
      if (name !== 'connection') return undefined
      return {
        browserPeer: { principal: { kind: 'owner' } },
        createSharedFetchHandler: () => ({
          fetch: async (request: Request) => {
            requests.push(request)
            return await respond(request)
          },
        }),
      }
    },
  }
  const bridge = new WebviewBridge(
    ctx as never,
    join('C:/detail-image-test', 'launch', 'activation-1'),
    { asUri: path => path, postMessage: async (frame) => { frames.push(frame as Frame) } },
    () => {},
  )
  return { bridge, frames, requests }
}

function answerTo(frames: readonly Frame[], id: number): Frame {
  const answer = frames.find(frame => frame.type === 'fetch-result' && frame.id === id)
  if (answer === undefined) throw new Error(`no fetch-result for ${String(id)}: ${JSON.stringify(frames)}`)
  return answer
}

describe('detail image route matching', () => {
  const query = '?bundle=%40acme%2Fx&document=guide%2FD.md&path=img%2Fa+b.png'

  it('matches both detail-file routes and keeps their query', () => {
    expect(detailImageRoute(`api/plugin-manager/detail-file${query}`, BASE_URI))
      .toBe(`/api/plugin-manager/detail-file${query}`)
    expect(detailImageRoute(`api/plugin-market/detail-file?document=doc&path=img/a.png`, BASE_URI))
      .toBe('/api/plugin-market/detail-file?document=doc&path=img/a.png')
  })

  it('matches the absolute source a page resolves against the document base', () => {
    expect(detailImageRoute(`vscode-webview://webview/api/plugin-manager/detail-file${query}`, BASE_URI))
      .toBe(`/api/plugin-manager/detail-file${query}`)
  })

  it('leaves every other source alone', () => {
    for (const source of [
      'api/plugin-manager/detail-files?x=1',
      'api/plugin-manager/detail-file/extra',
      'api/file?path=%2Ftmp%2Fa.png',
      'img/a.png',
      'data:image/png;base64,AAAA',
      `blob:${BASE_URI}#a.png`,
      '',
    ]) {
      expect(detailImageRoute(source, BASE_URI), source).toBeUndefined()
    }
  })

  it('keeps the Webview bound equal to the Host transfer bound', () => {
    expect(MAX_DETAIL_IMAGE_BYTES).toBe(MAX_BINARY_RESPONSE_BYTES)
  })
})

describe('detail image bytes', () => {
  it('round-trips bytes through the host encoder and the webview decoder', () => {
    expect([...decodeBase64(encodeBase64(PNG_BYTES))]).toEqual([...PNG_BYTES])
  })

  it('decodes the empty body of a failed answer', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array())
  })
})

describe('readBoundedBody', () => {
  it('reads a body within the limit', async () => {
    expect([...await readBoundedBody(new Response(PNG_BYTES), PNG_BYTES.byteLength)]).toEqual([...PNG_BYTES])
  })

  it('rejects a declared length above the limit', async () => {
    const response = new Response(new Uint8Array(8), { headers: { 'content-length': '8' } })
    await expect(readBoundedBody(response, 4)).rejects.toThrow(/declares 8 bytes/u)
  })

  it('rejects a body that grows past the limit', async () => {
    await expect(readBoundedBody(new Response(new Uint8Array(8)), 4)).rejects.toThrow(/exceeds the 4-byte limit/u)
  })

  it('reads a response without a body as empty', async () => {
    expect(await readBoundedBody(new Response(null), 4)).toEqual(new Uint8Array())
  })
})

describe('WebviewBridge binary answers', () => {
  it('answers a binary request with bytes, media type, and status', async () => {
    const { bridge, frames, requests } = harness(async () => new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png' },
    }))
    await bridge.handle({
      type: 'fetch',
      id: 11,
      url: '/api/plugin-manager/detail-file?bundle=a&document=README.md&path=a.png',
      method: 'GET',
      binary: true,
    })
    const answer = answerTo(frames, 11)
    expect(answer.status).toBe(200)
    expect(answer.contentType).toBe('image/png')
    expect(answer.body).toBeUndefined()
    expect([...decodeBase64(answer.base64 ?? '')]).toEqual([...PNG_BYTES])
    expect(requests[0]?.method).toBe('GET')
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/plugin-manager/detail-file')
    bridge.dispose()
  })

  it('keeps the text answer for a request without the opt-in', async () => {
    const { bridge, frames } = harness(async () => Response.json({ result: { ok: true } }))
    await bridge.handle({ type: 'fetch', id: 12, url: '/api/session/list', body: '{}' })
    expect(answerTo(frames, 12)).toEqual({
      type: 'fetch-result',
      id: 12,
      status: 200,
      body: '{"result":{"ok":true}}',
    })
    bridge.dispose()
  })

  it('reports a failed binary request as bytes under status 500', async () => {
    const { bridge, frames } = harness(async () => { throw new Error('route failed') })
    await bridge.handle({ type: 'fetch', id: 13, url: '/api/plugin-market/detail-file?document=d', binary: true })
    const answer = answerTo(frames, 13)
    expect(answer.status).toBe(500)
    expect(answer.contentType).toBe('application/json')
    const failure: unknown = JSON.parse(new TextDecoder().decode(decodeBase64(answer.base64 ?? '')))
    expect(failure).toEqual({ error: 'route failed' })
    bridge.dispose()
  })

  it('refuses a binary body above the transfer bound', async () => {
    const { bridge, frames } = harness(async () => new Response(
      new Uint8Array(MAX_BINARY_RESPONSE_BYTES + 1),
      { headers: { 'content-type': 'image/png' } },
    ))
    await bridge.handle({ type: 'fetch', id: 14, url: '/api/plugin-manager/detail-file?document=d', binary: true })
    const answer = answerTo(frames, 14)
    expect(answer.status).toBe(500)
    const failure = new TextDecoder().decode(decodeBase64(answer.base64 ?? ''))
    expect(failure).toContain('limit')
    bridge.dispose()
  })
})
