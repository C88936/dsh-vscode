/**
 * Webview transport: standard Request/init normalization, cancellation before
 * the first frame, acknowledged upload bodies, lazy asset preparation, and
 * teardown when the companion transport ends.
 *
 * The tests drive the shipped transport class with a controlled Host, so a
 * frame is asserted as the Webview would actually send it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebviewTransport, resolveAsset } from '../src/webview/main.ts'
import { DEFAULT_BRIDGE_LIMITS, type BridgeLimits } from '../src/shared/limits.ts'

/** One frame the transport posted. */
interface Sent {
  readonly type: string
  readonly id?: number
  readonly seq?: number
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly data?: string
  readonly binary?: boolean
  readonly item?: unknown
}

type HostFrame = Parameters<WebviewTransport['handleFrame']>[0]

interface Harness {
  readonly transport: WebviewTransport
  readonly sent: Sent[]
  deliver(frame: HostFrame): void
  assets(): Readonly<Record<string, string>>
}

function harness(limits: BridgeLimits = DEFAULT_BRIDGE_LIMITS): Harness {
  const sent: Sent[] = []
  let assets: Record<string, string> = {}
  const transport = new WebviewTransport(
    message => { sent.push(message as Sent) },
    merged => { assets = { ...assets, ...merged } },
    url => assets[url] ?? url,
    url => assets[url] !== undefined,
    limits,
  )
  return {
    transport,
    sent,
    deliver: frame => { transport.handleFrame(frame) },
    assets: () => assets,
  }
}

/**
 * One unary text body that stays open until its source is cancelled or written.
 * @param onCancel - receives the cancellation, so a test can prove the reader
 * was released rather than left reading.
 * @returns the body stream and its controller.
 */
function openTextBody(onCancel?: () => void): {
  readonly body: ReadableStream<Uint8Array>
  push(chunk: string | Uint8Array): void
  close(): void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start: (next) => { controller = next },
    cancel: () => { onCancel?.() },
  })
  return {
    body,
    push: (chunk) => { controller?.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk) },
    close: () => { controller?.close() },
  }
}

async function nextFrame(
  sent: readonly Sent[],
  predicate: (frame: Sent) => boolean,
  label: string,
): Promise<Sent> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const frame = sent.find(predicate)
    if (frame !== undefined) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}; sent ${JSON.stringify(sent)}`)
}

/** Let queued microtasks and timers run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('WebviewTransport request normalization', () => {
  it('keeps the URL+init call shape the Host routes already use', async () => {
    const { transport, sent, deliver } = harness()
    const answer = transport.fetch('/api/audit', {
      method: 'PUT',
      headers: { 'x-audit': 'yes', 'content-type': 'application/json' },
      body: 'audit-body',
    })
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    expect(frame).toMatchObject({
      url: '/api/audit',
      method: 'PUT',
      headers: { 'x-audit': 'yes', 'content-type': 'application/json' },
      body: 'audit-body',
    })
    deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{"ok":true}' })
    const response = await answer
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('inherits method, headers, and text body from a Request with no init', async () => {
    const { transport, sent, deliver } = harness()
    const answer = transport.fetch(new Request('http://dsh.local/api/audit', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'x-origin': 'request' },
      body: 'request-body',
    }))
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    expect(frame).toMatchObject({
      url: '/api/audit',
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'x-origin': 'request' },
      body: 'request-body',
    })
    deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{}' })
    await answer
  })

  it('applies init over the Request fields exactly as the Fetch constructor does', async () => {
    const { transport, sent, deliver } = harness()
    const answer = transport.fetch(
      new Request('http://dsh.local/api/audit', {
        method: 'PUT',
        headers: { 'x-origin': 'request' },
        body: 'request-body',
      }),
      { method: 'POST', headers: { 'x-init': 'init' }, body: 'init-body' },
    )
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    expect(frame.method).toBe('POST')
    expect(frame.body).toBe('init-body')
    // init.headers replace the Request's own list, and a string body adds the
    // constructor's standard text/plain content type.
    expect(frame.headers?.['x-init']).toBe('init')
    expect(frame.headers?.['x-origin']).toBeUndefined()
    expect(frame.headers?.['content-type']).toBe('text/plain;charset=UTF-8')
    deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{}' })
    await answer
  })

  it('sends GET and HEAD without inventing a POST or a body', async () => {
    const { transport, sent, deliver } = harness()
    const get = transport.fetch(new Request('http://dsh.local/api/state'))
    const getFrame = await nextFrame(sent, item => item.type === 'fetch', 'GET frame')
    expect(getFrame.method).toBe('GET')
    expect('body' in getFrame).toBe(false)
    deliver({ type: 'fetch-result', id: getFrame.id as number, status: 200, body: '{}' })
    await get

    const head = transport.fetch(new Request('http://dsh.local/api/state', { method: 'HEAD' }))
    const headFrame = await nextFrame(sent, item => item.type === 'fetch' && item.id !== getFrame.id, 'HEAD frame')
    expect(headFrame.method).toBe('HEAD')
    expect('body' in headFrame).toBe(false)
    deliver({ type: 'fetch-result', id: headFrame.id as number, status: 200, body: '' })
    await head
  })

  it('rejects an already cancelled Request signal before sending a frame', async () => {
    const { transport, sent } = harness()
    const controller = new AbortController()
    controller.abort()
    const request = new Request('http://dsh.local/api/audit', { method: 'PUT', body: 'x', signal: controller.signal })
    await expect(transport.fetch(request)).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toEqual([])
  })

  it('rejects an already cancelled init signal before sending a frame', async () => {
    const { transport, sent } = harness()
    const controller = new AbortController()
    controller.abort()
    const request = new Request('http://dsh.local/api/audit', { method: 'PUT', body: 'x' })
    await expect(transport.fetch(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toEqual([])
  })

  it('lets the init signal override the Request signal', async () => {
    const { transport, sent, deliver } = harness()
    const requestSignal = new AbortController()
    const initSignal = new AbortController()
    const request = new Request('http://dsh.local/api/audit', {
      method: 'POST',
      body: 'x',
      signal: requestSignal.signal,
    })
    const answer = transport.fetch(request, { signal: initSignal.signal })
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    requestSignal.abort()
    await settle()
    expect(sent.some(item => item.type === 'fetch-cancel')).toBe(false)
    deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{}' })
    await answer
  })

  it('cancels one in-flight fetch exactly once and stops listening', async () => {
    const { transport, sent } = harness()
    const controller = new AbortController()
    const answer = transport.fetch('/api/audit', { method: 'PUT', body: 'x', signal: controller.signal })
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    controller.abort()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent.filter(item => item.type === 'fetch-cancel')).toHaveLength(1)
    // A late answer for the cancelled request settles nothing and throws nothing.
    transport.handleFrame({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{}' })
  })

  it('rejects an already consumed Request body before sending a frame', async () => {
    const { transport, sent } = harness()
    const request = new Request('http://dsh.local/api/audit', { method: 'PUT', body: 'already-read' })
    await request.text()
    await expect(transport.fetch(request)).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it('rejects a binary or untyped unary body before sending a frame', async () => {
    const { transport, sent } = harness()
    await expect(transport.fetch(new Request('http://dsh.local/api/audit', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    }))).rejects.toThrow(/file-upload carrier/u)
    await expect(transport.fetch(new Request('http://dsh.local/api/audit', {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    }))).rejects.toThrow(/file-upload carrier/u)
    expect(sent).toEqual([])
  })

  it('asks for the binary answer only when the caller opted in', async () => {
    const { transport, sent, deliver } = harness()
    const controller = new AbortController()
    const answer = transport.binaryFetch('/api/plugin-manager/detail-file?path=x', controller.signal)
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'binary frame')
    expect(frame).toMatchObject({ method: 'GET', binary: true })
    deliver({
      type: 'fetch-result',
      id: frame.id as number,
      status: 200,
      base64: Buffer.from('bytes').toString('base64'),
      contentType: 'image/png',
    })
    expect(await answer).toMatchObject({ status: 200, contentType: 'image/png' })
  })
})

describe('WebviewTransport uploads', () => {
  /** A body of fixed chunks, so the pump's per-chunk protocol is observable. */
  function bodyOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
  }

  it('carries a Request body byte-for-byte with its method and content type', async () => {
    const { transport, sent, deliver } = harness()
    const request = new Request('http://dsh.local/api/upload', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyOf('upload-body'),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const answer = transport.upload(request)
    const open = await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    expect(open).toMatchObject({
      url: '/api/upload',
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    })
    const chunk = await nextFrame(sent, item => item.type === 'upload-chunk', 'upload chunk')
    expect(Buffer.from(chunk.data as string, 'base64').toString('utf8')).toBe('upload-body')
    deliver({ type: 'upload-ack', id: open.id as number, seq: chunk.seq as number })
    const end = await nextFrame(sent, item => item.type === 'upload-end', 'upload end')
    deliver({ type: 'upload-ack', id: open.id as number, seq: end.seq as number })
    deliver({ type: 'upload-result', id: open.id as number, status: 200, body: '{"ok":true}' })
    const response = await answer
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('stops sending after the caller cancels and releases the pending acknowledgement', async () => {
    const { transport, sent, deliver } = harness()
    const controller = new AbortController()
    const answer = transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyOf('first', 'second'),
      signal: controller.signal,
    })
    const open = await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    const first = await nextFrame(sent, item => item.type === 'upload-chunk', 'first chunk')
    controller.abort()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent.filter(item => item.type === 'upload-cancel')).toHaveLength(1)
    deliver({ type: 'upload-ack', id: open.id as number, seq: first.seq as number })
    await settle()
    expect(sent.filter(item => item.type === 'upload-chunk')).toHaveLength(1)
    expect(sent.some(item => item.type === 'upload-end')).toBe(false)
  })

  it('settles once when the Host answers before the body ends', async () => {
    const { transport, sent, deliver } = harness()
    const answer = transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyOf('first', 'second'),
    })
    const open = await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    const first = await nextFrame(sent, item => item.type === 'upload-chunk', 'first chunk')
    deliver({ type: 'upload-ack', id: open.id as number, seq: first.seq as number })
    deliver({ type: 'upload-result', id: open.id as number, status: 400, body: '{"error":"refused"}' })
    const response = await answer
    expect(response.status).toBe(400)
    await settle()
    expect(sent.filter(item => item.type === 'upload-chunk')).toHaveLength(1)
  })

  it('ignores a duplicate upload answer after the request settled', async () => {
    const { transport, sent, deliver } = harness()
    const answer = transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyOf('only'),
    })
    const open = await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    const chunk = await nextFrame(sent, item => item.type === 'upload-chunk', 'upload chunk')
    deliver({ type: 'upload-ack', id: open.id as number, seq: chunk.seq as number })
    deliver({ type: 'upload-result', id: open.id as number, status: 200, body: '{"ok":true}' })
    expect((await answer).status).toBe(200)
    // A repeated answer must neither throw nor resolve a second request.
    expect(() => { deliver({ type: 'upload-result', id: open.id as number, status: 500, body: '{}' }) }).not.toThrow()
    expect(sent.filter(item => item.type === 'upload-chunk')).toHaveLength(1)
  })

  it('rejects an upload without a body before opening it', async () => {
    const { transport, sent } = harness()
    await expect(transport.upload('/api/upload', { method: 'POST' })).rejects.toThrow('upload body is missing')
    expect(sent).toEqual([])
  })

  it('cancels the body reader and settles when the transport ends during the upload', async () => {
    const { transport, sent } = harness()
    let cancelled = false
    // Nothing is enqueued, so the pump is waiting on the body when the transport ends.
    const body = new ReadableStream<Uint8Array>({
      start: () => {},
      cancel: () => { cancelled = true },
    })
    const answer = transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    })
    await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    transport.dispose('the companion exited')
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    await settle()
    // The waiting reader is released, and no chunk or end frame is sent to a closed transport.
    expect(cancelled).toBe(true)
    expect(sent.some(item => item.type === 'upload-chunk')).toBe(false)
    expect(sent.some(item => item.type === 'upload-end')).toBe(false)
    expect(transport.pendingCount).toBe(0)
  })

  it('serves a replacement page after the previous transport ended', async () => {
    const first = harness()
    first.transport.dispose('the companion exited')
    // A replaced page owns a new transport; nothing from the closed one is reused.
    const second = harness()
    const answer = second.transport.fetch('/api/state')
    const frame = await nextFrame(second.sent, item => item.type === 'fetch', 'fetch frame')
    second.deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{"ok":true}' })
    expect((await answer).status).toBe(200)
    expect(first.sent).toEqual([])
  })
})

describe('WebviewTransport teardown and lazy assets', () => {
  it('settles every pending request when the Host transport ends', async () => {
    const { transport, sent } = harness()
    const answer = transport.fetch('/api/audit', { method: 'PUT', body: 'x' })
    await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    transport.handleFrame({ type: 'transport-reset', reason: 'the companion exited' })
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    // Nothing is sent to a transport that already ended.
    expect(sent.some(item => item.type === 'fetch-cancel')).toBe(false)
    expect(transport.handleFrame({ type: 'fetch-result', id: 1, status: 200, body: '{}' })).toBe(true)
  })

  it('loads a bundle only after its package assets were applied', async () => {
    const appended: { src?: string; nonce?: string; onload?: () => void }[] = []
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({}),
        head: { append: (element: { onload?: () => void }) => { queueMicrotask(() => element.onload?.()) } },
      },
    })
    try {
      const { transport, sent, deliver, assets } = harness()
      const loading = transport.loadBundle('/plugins/demo/client.js')
      const request = await nextFrame(sent, item => item.type === 'asset', 'asset request')
      expect(request.url).toBe('/plugins/demo/client.js')
      deliver({
        type: 'asset-result',
        id: request.id as number,
        uri: 'vscode-webview://test/demo.js',
        assets: { 'plugins/demo/assets/icon-1.png': 'vscode-webview://test/icon.png' },
      })
      await loading
      expect(assets()['plugins/demo/assets/icon-1.png']).toBe('vscode-webview://test/icon.png')
    } finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  it('fails the bundle load when the Host cannot prepare the package assets', async () => {
    let appended = 0
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({}),
        head: { append: () => { appended++ } },
      },
    })
    try {
      const { transport, sent, deliver } = harness()
      const loading = transport.loadBundle('/plugins/demo/client.js')
      const request = await nextFrame(sent, item => item.type === 'asset', 'asset request')
      deliver({ type: 'asset-result', id: request.id as number, error: 'the package does not export that file' })
      await expect(loading).rejects.toThrow('does not export')
      // The dependent script never executes against missing asset URLs.
      expect(appended).toBe(0)
    } finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

describe('WebviewTransport closure', () => {
  /** One fixed body of two chunks, so an upload can start without reading far. */
  function bodyOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
  }

  it('refuses every public call after the transport ended', async () => {
    const { transport, sent } = harness()
    transport.dispose('the companion exited')
    const controller = new AbortController()
    await expect(transport.fetch('/api/audit')).rejects.toMatchObject({
      name: 'TransportClosedError',
      code: 'transport/closed',
    })
    await expect(transport.binaryFetch('/api/plugin-manager/detail-file', controller.signal)).rejects.toMatchObject({
      code: 'transport/closed',
    })
    await expect(transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: bodyOf('x'),
    })).rejects.toMatchObject({ code: 'transport/closed' })
    await expect(transport.loadBundle('/plugins/demo/client.js')).rejects.toMatchObject({ code: 'transport/closed' })
    await expect(transport.openStream('session/follow', {}, controller.signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'transport/closed' })
    // Nothing was registered for a Host that cannot answer, and nothing was sent.
    expect(transport.pendingCount).toBe(0)
    expect(sent).toEqual([])
  })

  it('clears every pending wait when the Host resets the transport', async () => {
    const { transport, sent, deliver } = harness()
    const fetchAnswer = transport.fetch('/api/audit', { method: 'PUT', body: 'x' })
    await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    const upload = transport.upload('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyOf('first', 'second'),
    })
    await nextFrame(sent, item => item.type === 'upload-open', 'upload open')
    deliver({ type: 'transport-reset', reason: 'the companion exited' })
    await expect(fetchAnswer).rejects.toMatchObject({ name: 'AbortError' })
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    // Nothing keeps waiting for the process that is gone.
    expect(transport.pendingCount).toBe(0)
    expect(transport.closedReason).toBe('the companion exited')
  })

  it('settles every wait and refuses later calls when a frame cannot be posted', async () => {
    const sent: Sent[] = []
    let fail = false
    const transport = new WebviewTransport(
      (message) => {
        if (fail) throw new Error('the Webview was disposed')
        sent.push(message as Sent)
      },
      () => {},
      url => url,
      () => false,
    )
    const pending = transport.fetch('/api/audit', { method: 'PUT', body: 'x' })
    await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    fail = true
    const second = transport.fetch('/api/other', { method: 'POST', body: 'y' })
    await expect(second).rejects.toMatchObject({ name: 'TransportClosedError', code: 'transport/closed' })
    // The request that was already sent belongs to the same closed page, so it
    // is settled too instead of waiting for a frame nobody will post.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(transport.fetch('/api/third')).rejects.toMatchObject({ code: 'transport/closed' })
    expect(transport.pendingCount).toBe(0)
  })
})

describe('WebviewTransport unary body reading', () => {
  /** A Request whose text body is the given stream. */
  function streamedRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Request {
    return new Request('http://dsh.local/api/audit', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
      signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  }

  it('cancels the body reader when the request aborts during the read', async () => {
    const { transport, sent } = harness()
    let cancelled = false
    const body = openTextBody(() => { cancelled = true })
    const controller = new AbortController()
    const answer = transport.fetch(streamedRequest(body.body, controller.signal))
    await settle()
    expect(cancelled).toBe(false)
    controller.abort()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    // The request was cancelled before its first frame, so the Host saw nothing.
    expect(sent).toEqual([])
    expect(transport.pendingCount).toBe(0)
  })

  it('cancels the body reader when the transport ends during the read', async () => {
    const { transport, sent } = harness()
    let cancelled = false
    const body = openTextBody(() => { cancelled = true })
    const answer = transport.fetch(streamedRequest(body.body))
    await settle()
    transport.dispose('the companion exited')
    await expect(answer).rejects.toMatchObject({ name: 'TransportClosedError', code: 'transport/closed' })
    expect(cancelled).toBe(true)
    expect(sent).toEqual([])
  })

  it('refuses a body above the configured unary limit before sending a frame', async () => {
    const { transport, sent } = harness({ ...DEFAULT_BRIDGE_LIMITS, unaryBodyBytes: 4 })
    await expect(transport.fetch('/api/audit', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'too large',
    })).rejects.toThrow(/unary limit/u)
    expect(sent).toEqual([])
  })

  it('keeps multi-byte characters that cross chunk boundaries', async () => {
    const { transport, sent, deliver } = harness()
    const body = openTextBody()
    const answer = transport.fetch(streamedRequest(body.body))
    const encoded = new TextEncoder().encode('模型 ok')
    // Split inside the first three-byte character, then inside the second.
    body.push(encoded.slice(0, 2))
    body.push(encoded.slice(2, 5))
    body.push(encoded.slice(5))
    body.close()
    const frame = await nextFrame(sent, item => item.type === 'fetch', 'fetch frame')
    expect(frame.body).toBe('模型 ok')
    deliver({ type: 'fetch-result', id: frame.id as number, status: 200, body: '{}' })
    await answer
  })

  it('does not carry a body read cancelled after its first chunk', async () => {
    const { transport, sent } = harness()
    let cancelled = false
    const body = openTextBody(() => { cancelled = true })
    const controller = new AbortController()
    const answer = transport.fetch(streamedRequest(body.body, controller.signal))
    body.push('first')
    await settle()
    controller.abort()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(sent).toEqual([])
  })
})

describe('package asset resolution', () => {
  it('fails a declared package asset the Host did not prepare', () => {
    // The Host withholds a whole package when one of its assets fails, so the
    // requesting code must not run against the literal reference.
    expect(() => resolveAsset('plugins/demo/assets/icon-1.png')).toThrow(/was not prepared/u)
  })

  it('leaves a reference that is not a package asset alone', () => {
    expect(resolveAsset('https://example.com/icon.png')).toBe('https://example.com/icon.png')
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
})
