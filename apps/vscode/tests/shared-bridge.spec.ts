/**
 * Window bridge over a real shared-host listener: boot payload mapping, frame
 * forwarding, asset URI mapping, host-wide activity answers, reset on disconnect,
 * and deliberate disposal without a reset.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withHostControl } from '../src/companion/activity.ts'
import { SharedHostServer, type HostSession } from '../src/companion/server.ts'
import { WindowRequests, type WindowAnswer } from '../src/companion/window-requests.ts'
import { SharedHostBridge } from '../src/host/shared-bridge.ts'
import { HostRefusedError } from '../src/host/host-client.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'
import type { TerminalRunOptions, TerminalRunResult } from '../src/host/terminal.ts'

const TOKEN = 'a'.repeat(64)
const roots: string[] = []
const servers: SharedHostServer[] = []
let shutdownCalls = 0
let shutdownOutcome: { readonly ok: boolean; readonly error?: string } = { ok: true }

afterEach(async () => {
  shutdownCalls = 0
  shutdownOutcome = { ok: true }
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a named pipe or socket path unique to one test.
 */
function uniqueEndpoint(): string {
  const suffix = `${String(process.pid)}-${Math.random().toString(16).slice(2, 10)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-shared-bridge-${suffix}`
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-bridge-'))
  roots.push(root)
  return join(root, 'host.sock')
}

/** One host that echo-answers frames through the activity wrapper. */
interface Fixture {
  readonly endpoint: string
  readonly server: SharedHostServer
  readonly disposed: string[]
  /** Frames the window sent back over its connection. */
  readonly received: unknown[]
  /** The admitted connection, for sending host-initiated requests. */
  readonly connection: { send(frame: unknown): void }
}

/**
 * @param token - credential the host requires.
 * @returns the started fixture.
 */
async function startHost(token = TOKEN, windows?: WindowRequests): Promise<Fixture> {
  const endpoint = uniqueEndpoint()
  const disposed: string[] = []
  const received: unknown[] = []
  let admitted: { send(frame: unknown): void } | undefined
  const server = new SharedHostServer({
    endpoint,
    token,
    instanceId: 'instance-1',
    dshVersion: '0.2.2-alpha.2',
    configFingerprint: 'config-1',
    log: () => {},
    ...process.platform === 'win32' ? {} : { staleSocketPath: endpoint },
    createSession: async (hello, connection): Promise<HostSession> => {
      admitted = connection
      const base: HostSession = {
        ready: {
          injections: [],
          assets: { '/bundle.js': 'C:/storage/connection-1/webview/bundles/b.js' },
          shell: 'C:/storage/shell.js',
          styles: ['C:/storage/shell.css'],
          limits: DEFAULT_BRIDGE_LIMITS,
        },
        handle: async (frame: unknown) => {
          received.push(frame)
          const decoded = frame as { type?: unknown; id?: unknown }
          if (decoded.type === 'fetch') {
            connection.send({ type: 'fetch-result', id: decoded.id, status: 200, body: 'ok' })
            return
          }
          if (decoded.type === 'asset') {
            connection.send({
              type: 'asset-result',
              id: decoded.id,
              uri: 'C:/storage/late.js',
              assets: { '/late.png': 'C:/storage/late.png' },
            })
          }
        },
        dispose: () => { disposed.push(hello.clientId) },
      }
      const agents = { list: () => [{ status: 'running' }] }
      const session = withHostControl(base, connection, {
        activity: () => ({ runningTurns: agents.list().length, packageOperations: 1, runningTerminals: 0 }),
        config: () => ({ provider: 'company', model: 'qwen-max', configured: true }),
        shutdown: () => {
          shutdownCalls++
          return { ...shutdownOutcome }
        },
      })
      return windows === undefined ? session : windows.bind(connection, session)
    },
  })
  await server.listen()
  servers.push(server)
  return {
    endpoint,
    server,
    disposed,
    received,
    // Admission happens when a window connects, after this fixture returns.
    get connection() {
      if (admitted === undefined) throw new Error('no window has connected to the host yet')
      return admitted
    },
  }
}

/** Webview recorder with a URI prefix that proves path mapping. */
function recorder(): {
  readonly frames: { readonly type?: unknown; readonly [key: string]: unknown }[]
  readonly webview: { asUri(path: string): string; postMessage(message: unknown): Promise<boolean> }
} {
  const frames: { readonly type?: unknown; readonly [key: string]: unknown }[] = []
  return {
    frames,
    webview: {
      asUri: path => `uri:${path}`,
      postMessage: async (message) => {
        frames.push(message as { type?: unknown })
        return true
      },
    },
  }
}

/**
 * @param endpoint - host endpoint. @param frames - webview recorder.
 * @param options - token and identity overrides.
 * @returns bridge options.
 */
function bridgeOptions(
  endpoint: string,
  sink: ReturnType<typeof recorder>,
  options: {
    readonly token?: string
    readonly onExit?: (reason: string) => void
    readonly onMaintenance?: (active: boolean, reason?: string) => void
    readonly runInTerminal?: (command: string, cwd: string, options: TerminalRunOptions) => Promise<TerminalRunResult>
    readonly openFile?: (path: string) => Promise<{ ok: boolean; error?: string }>
  } = {},
) {
  return {
    endpoint,
    token: options.token ?? TOKEN,
    clientId: 'window-a',
    extensionVersion: '0.0.0-test',
    configFingerprint: 'config-1',
    limits: DEFAULT_BRIDGE_LIMITS,
    workspacePath: 'C:/workspace',
    webview: sink.webview,
    log: () => {},
    ...options.onExit === undefined ? {} : { onExit: options.onExit },
    ...options.onMaintenance === undefined ? {} : { onMaintenance: options.onMaintenance },
    ...options.runInTerminal === undefined ? {} : { runInTerminal: options.runInTerminal },
    ...options.openFile === undefined ? {} : { openFile: options.openFile },
  }
}

/**
 * Wait until a condition holds.
 * @param check - condition. @param timeoutMs - maximum wait.
 */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold before the deadline')
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('SharedHostBridge', () => {
  it('maps the boot payload and forwards frames through the real host', async () => {
    const host = await startHost()
    const sink = recorder()
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink))
    const payload = await bridge.prepare('/unused')
    expect(payload.shell).toBe('uri:C:/storage/shell.js')
    expect(payload.styles).toEqual(['uri:C:/storage/shell.css'])
    expect(payload.assets).toEqual({ '/bundle.js': 'uri:C:/storage/connection-1/webview/bundles/b.js' })

    await bridge.handle({ type: 'fetch', id: 7, url: '/api/x' })
    await until(() => sink.frames.some(frame => frame.type === 'fetch-result'))
    expect(sink.frames.find(frame => frame.type === 'fetch-result')).toMatchObject({ id: 7, status: 200, body: 'ok' })

    await bridge.handle({ type: 'asset', id: 8, url: '/late.js' })
    await until(() => sink.frames.some(frame => frame.type === 'asset-result'))
    expect(sink.frames.find(frame => frame.type === 'asset-result')).toMatchObject({
      id: 8,
      uri: 'uri:C:/storage/late.js',
      assets: { '/late.png': 'uri:C:/storage/late.png' },
    })

    expect(await bridge.activity()).toEqual({ runningTurns: 1, packageOperations: 1, runningTerminals: 0 })
    await bridge.dispose()
    await until(() => host.disposed.includes('window-a'))
  })

  it('resets the page and reports an unexpected host disconnect', async () => {
    const host = await startHost()
    const sink = recorder()
    const exits: string[] = []
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink, {
      onExit: reason => { exits.push(reason) },
    }))
    await host.server.close()
    await until(() => exits.length === 1)
    expect(exits[0]).toContain('closed the connection')
    await until(() => sink.frames.some(frame => frame.type === 'transport-reset'))
    await expect(bridge.activity()).rejects.toThrow(/closed the connection/u)
    await expect(bridge.shutdownHost()).rejects.toThrow(/closed the connection/u)
  })

  it('asks the host to stop and receives its acceptance or refusal', async () => {
    const host = await startHost()
    const sink = recorder()
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink))
    shutdownOutcome = { ok: false, error: 'DSH still reports 1 running turn; the shared host was not stopped.' }
    await expect(bridge.shutdownHost()).resolves.toEqual(shutdownOutcome)
    shutdownOutcome = { ok: true }
    await expect(bridge.shutdownHost()).resolves.toEqual({ ok: true })
    expect(shutdownCalls).toBe(2)
    await bridge.dispose()
  })

  it('disposes without a transport reset', async () => {
    const host = await startHost()
    const sink = recorder()
    const exits: string[] = []
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink, {
      onExit: reason => { exits.push(reason) },
    }))
    await bridge.dispose()
    await until(() => host.disposed.includes('window-a'))
    expect(exits).toEqual([])
    expect(sink.frames.some(frame => frame.type === 'transport-reset')).toBe(false)
  })

  it('runs the terminal and editor requests the host sends, and answers over the connection', async () => {
    const host = await startHost()
    const sink = recorder()
    const calls: string[] = []
    let aborted = false
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink, {
      runInTerminal: async (command, cwd, options) => {
        if (command === 'sleep') {
          return await new Promise((resolve) => {
            options.signal?.addEventListener('abort', () => {
              aborted = true
              resolve({ ok: true, run: { output: '', exitCode: undefined, timedOut: false, aborted: true, truncated: false } })
            })
          })
        }
        calls.push(`${command}@${cwd}`)
        return { ok: true, run: { output: 'hi\n', exitCode: 0, timedOut: false, aborted: false, truncated: false } }
      },
      openFile: async path => { calls.push(`open:${path}`); return { ok: true } },
    }))
    await bridge.prepare('/unused')

    host.connection.send({
      type: 'terminal-run', id: 31, command: 'echo hi', cwd: 'C:/w', timeoutMs: 1_000, onExpiry: 'kill', stdoutMaxBytes: 1_024,
    })
    await until(() => host.received.some(frame => (frame as { type?: string; id?: number }).type === 'terminal-result' && (frame as { id?: number }).id === 31))
    expect(host.received.find(frame => (frame as { id?: number }).id === 31)).toMatchObject({
      type: 'terminal-result', id: 31, ok: true, output: 'hi\n', exitCode: 0,
    })

    host.connection.send({ type: 'open-file', id: 32, path: 'C:/w/a.ts' })
    await until(() => host.received.some(frame => (frame as { type?: string; id?: number }).type === 'open-file-result' && (frame as { id?: number }).id === 32))
    expect(host.received.find(frame => (frame as { id?: number }).id === 32)).toMatchObject({ type: 'open-file-result', id: 32, ok: true })
    expect(calls).toEqual(['echo hi@C:/w', 'open:C:/w/a.ts'])

    // The host can cancel a command; the abort reaches the runner and the answer still returns.
    host.connection.send({ type: 'terminal-run', id: 33, command: 'sleep', cwd: 'C:/w', timeoutMs: 1_000, onExpiry: 'none', stdoutMaxBytes: 1_024 })
    host.connection.send({ type: 'terminal-cancel', id: 33 })
    await until(() => host.received.some(frame => (frame as { type?: string; id?: number }).type === 'terminal-result' && (frame as { id?: number }).id === 33))
    expect(aborted).toBe(true)
    expect(host.received.find(frame => (frame as { id?: number }).id === 33)).toMatchObject({ type: 'terminal-result', id: 33, aborted: true })

    await bridge.dispose()
  })

  it('keeps terminal ownership across window changes and settles a disconnected editor request', async () => {
    const answers: WindowAnswer[] = []
    const windows = new WindowRequests(answer => { answers.push(answer) })
    const host = await startHost(TOKEN, windows)
    const started = Promise.withResolvers<void>()
    const a = await SharedHostBridge.start(bridgeOptions(host.endpoint, recorder(), {
      runInTerminal: async (_command, _cwd, { signal }) => {
        started.resolve()
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => { resolve() }, { once: true }))
        return { ok: false, error: 'cancelled by owner' }
      },
    }))
    expect(windows.send({ type: 'terminal-run', id: 7, command: 'fixture', cwd: 'C:/w', timeoutMs: 10_000, onExpiry: 'kill', stdoutMaxBytes: 1024 })).toBe(true)
    await started.promise
    const opened = Promise.withResolvers<void>()
    const editorReply = Promise.withResolvers<{ ok: boolean }>()
    const b = await SharedHostBridge.start({
      ...bridgeOptions(host.endpoint, recorder(), {
        openFile: async () => {
          opened.resolve()
          return await editorReply.promise
        },
      }),
      clientId: 'window-b',
    })
    await b.handle({ type: 'terminal-result', id: 7, ok: true })
    expect(windows.send({ type: 'terminal-cancel', id: 7 })).toBe(true)
    await until(() => answers.some(answer => answer.type === 'terminal-result'))
    expect(answers).toEqual([{ type: 'terminal-result', id: 7, ok: false, error: 'cancelled by owner' }])
    expect(windows.send({ type: 'open-file', id: 7, path: 'C:/w/file.txt' })).toBe(true)
    await opened.promise
    await b.dispose()
    await until(() => answers.some(answer => answer.type === 'open-file-result'))
    expect(answers.at(-1)).toMatchObject({ type: 'open-file-result', id: 7, ok: false, error: expect.stringContaining('disconnected') })
    editorReply.resolve({ ok: true })
    await a.dispose()
  })

  it('broadcasts restart maintenance to ready windows and to windows that join during maintenance', async () => {
    const windows = new WindowRequests(() => {})
    const host = await startHost(TOKEN, windows)
    const connect = async (clientId: string) => {
      const notices: boolean[] = []
      const bridge = await SharedHostBridge.start({
        ...bridgeOptions(host.endpoint, recorder(), { onMaintenance: active => { notices.push(active) } }),
        clientId,
      })
      return { bridge, notices }
    }
    const a = await connect('window-a')
    const b = await connect('window-b')
    windows.broadcastMaintenance({ type: 'host-maintenance', active: true })
    await until(() => a.notices.length === 1 && b.notices.length === 1)
    const c = await connect('window-c')
    await until(() => c.notices.length === 1)
    windows.broadcastMaintenance({ type: 'host-maintenance', active: false })
    await until(() => [a, b, c].every(window => window.notices.length === 2))
    for (const window of [a, b, c]) {
      expect(window.notices).toEqual([true, false])
      await window.bridge.dispose()
    }
  })

  it('returns adapter exceptions to the Host as failed window requests', async () => {
    const answers: WindowAnswer[] = []
    const windows = new WindowRequests(answer => { answers.push(answer) })
    const host = await startHost(TOKEN, windows)
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, recorder(), {
      runInTerminal: async () => { throw new Error('terminal creation failed') },
      openFile: async () => { throw new Error('editor failed') },
    }))
    expect(windows.send({ type: 'terminal-run', id: 41, command: 'fixture', cwd: 'C:/w', timeoutMs: 1_000, onExpiry: 'kill', stdoutMaxBytes: 1024 })).toBe(true)
    expect(windows.send({ type: 'open-file', id: 42, path: 'C:/w/file.txt' })).toBe(true)
    await until(() => answers.length === 2)
    expect(answers).toEqual(expect.arrayContaining([
      { type: 'terminal-result', id: 41, ok: false, error: 'terminal creation failed' },
      { type: 'open-file-result', id: 42, ok: false, error: 'editor failed' },
    ]))
    await bridge.dispose()
  })

  it('asks the host for the deployment model configuration it booted with', async () => {
    const host = await startHost()
    const sink = recorder()
    const bridge = await SharedHostBridge.start(bridgeOptions(host.endpoint, sink))
    await bridge.prepare('/unused')
    await expect(bridge.modelConfig()).resolves.toEqual({ provider: 'company', model: 'qwen-max', configured: true })
    await bridge.dispose()
    await expect(bridge.modelConfig()).rejects.toThrow(/closed its shared host connection/u)
  })

  it('reports a refusal from the host', async () => {
    const host = await startHost('b'.repeat(64))
    const sink = recorder()
    await expect(SharedHostBridge.start(bridgeOptions(host.endpoint, sink)))
      .rejects.toBeInstanceOf(HostRefusedError)
    expect(sink.frames).toEqual([])
  })
})

