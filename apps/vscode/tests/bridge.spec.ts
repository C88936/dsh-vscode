/**
 * Host bridge streams: gateway opening is asynchronous, malformed failures
 * still settle in the Webview, and a missing failure classifier cannot create
 * an unhandled rejection. Materialized client bundles stay in the launch
 * directory the activation owns.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageInjections, WebviewBridge } from '../src/host/bridge.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

/** This activation's launch directory in the fixture. */
const LAUNCH_DIR = join('C:/bridge-test', 'launch', 'activation-1')

interface Frame {
  readonly type: string
  readonly id?: number
  readonly seq?: number
  readonly status?: number
  readonly body?: string
  readonly item?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

function harness(gateway: object): { bridge: WebviewBridge; frames: Frame[] } {
  const frames: Frame[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'typertGateway') return gateway
      if (name === 'connection') return { browserPeer: { principal: { kind: 'owner' } } }
      return undefined
    },
  }
  const bridge = new WebviewBridge(
    ctx as never,
    LAUNCH_DIR,
    {
      asUri: path => path,
      postMessage: async (frame) => { frames.push(frame as Frame) },
    },
    () => {},
  )
  return { bridge, frames }
}

async function waitFor(frames: readonly Frame[], predicate: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = frames.find(predicate)
    if (frame !== undefined) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for frame; received ${JSON.stringify(frames)}`)
}

describe('WebviewBridge streams', () => {  it('collects every host page injection row for the webview peer', () => {
    const peer = { principal: { kind: 'owner' } }
    const ctx = {
      emit: (name: string, table: { kind: string }[], received: unknown) => {
        expect(name).toBe('webserver/index-inject')
        expect(received).toBe(peer)
        table.push({ kind: 'global' }, { kind: 'script' })
      },
    }
    expect(pageInjections(ctx as never, peer as never)).toEqual([{ kind: 'global' }, { kind: 'script' }])
  })

  it('awaits the gateway stream iterable and forwards its items', async () => {
    const opened: unknown[] = []
    const { bridge, frames } = harness({
      wireStream: {
        open: async (endpoint: string, payload: unknown) => {
          opened.push({ endpoint, payload })
          return (async function * () {
            yield { type: 'baseline', value: { items: [] } }
          })()
        },
        failure: (error: unknown) => ({ code: 'gateway/internal', message: String(error) }),
      },
    })
    await bridge.handle({ type: 'stream-open', id: 7, endpoint: 'workspace/follow', payload: { args: {} } })
    const item = await waitFor(frames, frame => frame.type === 'stream-item' && frame.id === 7)
    const end = await waitFor(frames, frame => frame.type === 'stream-end' && frame.id === 7)
    expect(opened).toEqual([{ endpoint: 'workspace/follow', payload: { args: {} } }])
    expect(item.item).toEqual({ type: 'baseline', value: { items: [] } })
    expect(end.error).toBeUndefined()
    bridge.dispose()
  })

  it('reports a stream open failure even when its classifier also fails', async () => {
    const { bridge, frames } = harness({
      wireStream: {
        open: async () => { throw new Error('bad payload') },
        failure: () => { throw new Error('classifier failed') },
      },
    })
    await bridge.handle({ type: 'stream-open', id: 8, endpoint: 'workspace/follow', payload: {} })
    const end = await waitFor(frames, frame => frame.type === 'stream-end' && frame.id === 8)
    expect(end.error).toEqual({ code: 'gateway/internal', message: 'bad payload' })
    bridge.dispose()
  })

  it('keeps the webview resource directory inside the launch directory', () => {
    const { bridge } = harness({})
    expect(bridge.resourceDir).toBe(join(LAUNCH_DIR, 'webview'))
    bridge.dispose()
  })

  it('materializes each client bundle below the launch directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-bridge-'))
    try {
      const shellRoot = join(root, 'shell')
      mkdirSync(shellRoot, { recursive: true })
      writeFileSync(join(shellRoot, 'index.html'), '<script type="module" src="/assets/shell.js"></script>')
      const launchDir = join(root, 'launch', 'activation-1')
      const ctx = {
        get: (name: string) => {
          if (name === 'clientModules') {
            return {
              graph: () => ({ entries: [{ url: '/packages/example.js' }], batches: [] }),
              fetchBundle: async () => new Response('export const example = 1'),
              packageOf: () => undefined,
              packageAssetReferences: () => [],
            }
          }
          if (name === 'connection') return { browserPeer: { principal: { kind: 'owner' } } }
          return undefined
        },
        emit: () => {},
      }
      const bridge = new WebviewBridge(
        ctx as never,
        launchDir,
        { asUri: path => path, postMessage: async () => true },
        () => {},
      )
      const payload = await bridge.prepare(shellRoot)
      const asset = payload.assets['/packages/example.js']
      expect(asset).toBeDefined()
      expect(asset?.startsWith(join(launchDir, 'webview', 'bundles'))).toBe(true)
      expect(existsSync(asset ?? '')).toBe(true)
      bridge.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * WebviewBridge whose upload route exposes the body reader to the test, so a
 * chunk acknowledgement becomes observable against actual consumption.
 */
function uploadHarness(): {
  bridge: WebviewBridge
  frames: Frame[]
  opening: Promise<void>
  logs: string[]
  reader(): ReadableStreamDefaultReader<Uint8Array>
  respond(response: Response): void
} {
  const frames: Frame[] = []
  const logs: string[] = []
  const opening = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<Response>()
  let body: ReadableStreamDefaultReader<Uint8Array> | undefined
  const ctx = {
    get: (name: string) => {
      if (name !== 'connection') return undefined
      return {
        browserPeer: { principal: { kind: 'owner' } },
        createSharedFetchHandler: () => ({
          fetch: async (request: Request) => {
            body = request.body?.getReader()
            opening.resolve()
            return await answer.promise
          },
        }),
      }
    },
  }
  const bridge = new WebviewBridge(
    ctx as never,
    LAUNCH_DIR,
    { asUri: path => path, postMessage: async (frame) => { frames.push(frame as Frame) } },
    message => { logs.push(message) },
  )
  return {
    bridge,
    frames,
    logs,
    opening: opening.promise,
    reader: () => {
      if (body === undefined) throw new Error('the upload body was never opened')
      return body
    },
    respond: response => { answer.resolve(response) },
  }
}

describe('WebviewBridge upload acknowledgement', () => {
  it('acknowledges the next chunk only after the route consumed the previous one', async () => {
    const { bridge, frames, logs, opening, reader, respond } = uploadHarness()
    try {
      await bridge.handle({ type: 'upload-open', id: 11, url: '/api/upload', method: 'POST' })
      await opening
      // The stream's initial demand lets the first chunk through immediately.
      await bridge.handle({ type: 'upload-chunk', id: 11, seq: 1, data: Buffer.from('first').toString('base64') })
      await waitFor(frames, frame => frame.type === 'upload-ack' && frame.seq === 1)
      // The second chunk waits: the route has not read the first one yet.
      const second = bridge.handle({ type: 'upload-chunk', id: 11, seq: 2, data: Buffer.from('second').toString('base64') })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(frames.some(frame => frame.type === 'upload-ack' && frame.seq === 2)).toBe(false)
      const first = await reader().read()
      expect(Buffer.from(first.value ?? new Uint8Array()).toString('utf8')).toBe('first')
      await second
      await waitFor(frames, frame => frame.type === 'upload-ack' && frame.seq === 2)
      const next = await reader().read()
      expect(Buffer.from(next.value ?? new Uint8Array()).toString('utf8')).toBe('second')
      await bridge.handle({ type: 'upload-end', id: 11, seq: 3 })
      await waitFor(frames, frame => frame.type === 'upload-ack' && frame.seq === 3)
      expect((await reader().read()).done).toBe(true)
      respond(new Response('{"ok":true}', { status: 200 }))
      const result = await waitFor(frames, frame => frame.type === 'upload-result' && frame.id === 11)
      expect(result).toMatchObject({ status: 200, body: '{"ok":true}' })
      expect(logs.join('\n')).not.toContain('Webview request failed')
    } finally {
      bridge.dispose()
    }
  })

  it('settles a chunk sent after the route already answered', async () => {
    const { bridge, frames, opening, respond } = uploadHarness()
    try {
      await bridge.handle({ type: 'upload-open', id: 12, url: '/api/upload', method: 'POST' })
      await opening
      await bridge.handle({ type: 'upload-chunk', id: 12, seq: 1, data: Buffer.from('first').toString('base64') })
      respond(new Response('{"ok":true}', { status: 200 }))
      await waitFor(frames, frame => frame.type === 'upload-result' && frame.id === 12)
      // The sender is released instead of waiting for a body nobody reads.
      await bridge.handle({ type: 'upload-chunk', id: 12, seq: 2, data: Buffer.from('late').toString('base64') })
      await waitFor(frames, frame => frame.type === 'upload-ack' && frame.id === 12 && frame.seq === 2)
      await bridge.handle({ type: 'upload-end', id: 12, seq: 3 })
      expect(frames.filter(frame => frame.type === 'upload-result' && frame.id === 12)).toHaveLength(1)
    } finally {
      bridge.dispose()
    }
  })
})

describe('WebviewBridge connection scope', () => {
  it('passes the connection peer to fetch and to stream opening', async () => {
    const peer = { id: 'connection-peer', principal: { kind: 'owner' } }
    const received: unknown[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'connection') {
          return {
            browserPeer: { id: 'browser', principal: { kind: 'owner' } },
            createSharedFetchHandler: () => ({
              fetch: async (_request: Request, passed: unknown) => {
                received.push(passed)
                return new Response('{"ok":true}', { status: 200 })
              },
            }),
          }
        }
        if (name === 'typertGateway') {
          return {
            wireStream: {
              open: async (_endpoint: string, _payload: unknown, _uplink: unknown, passed: unknown) => {
                received.push(passed)
                return (async function * () {})()
              },
              failure: (error: unknown) => ({ code: 'gateway/internal', message: String(error) }),
            },
          }
        }
        return undefined
      },
    }
    const frames: Frame[] = []
    const bridge = new WebviewBridge(
      ctx as never,
      LAUNCH_DIR,
      { asUri: path => path, postMessage: async (frame) => { frames.push(frame as Frame) } },
      () => {},
      DEFAULT_BRIDGE_LIMITS,
      { peer: peer as never },
    )
    try {
      await bridge.handle({ type: 'fetch', id: 1, url: '/api/example' })
      await waitFor(frames, frame => frame.type === 'fetch-result' && frame.id === 1)
      await bridge.handle({ type: 'stream-open', id: 2, endpoint: 'session/follow', payload: {} })
      await waitFor(frames, frame => frame.type === 'stream-end' && frame.id === 2)
      expect(received).toEqual([peer, peer])
    } finally {
      bridge.dispose()
    }
  })

  it('materializes resources in the directory named for this connection', () => {
    const resourceDir = join('C:/bridge-test', 'connections', 'connection-1', 'webview')
    const bridge = new WebviewBridge(
      { get: () => undefined } as never,
      LAUNCH_DIR,
      { asUri: path => path, postMessage: async () => {} },
      () => {},
      DEFAULT_BRIDGE_LIMITS,
      { resourceDir },
    )
    expect(bridge.resourceDir).toBe(resourceDir)
    bridge.dispose()
  })
})
