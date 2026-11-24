/**
 * Window connection to a real shared host listener: admission, boot payload,
 * frame forwarding after the handshake, refusal reporting, close notification,
 * and the handshake deadline.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SharedHostServer, type HostSession } from '../src/companion/server.ts'
import { connectSharedHost, HostRefusedError, type SharedHostClientOptions } from '../src/host/host-client.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const TOKEN = 'a'.repeat(64)
const roots: string[] = []
const servers: SharedHostServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a named pipe or socket path unique to one test.
 */
function uniqueEndpoint(): string {
  const suffix = `${String(process.pid)}-${Math.random().toString(16).slice(2, 10)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-client-test-${suffix}`
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-client-'))
  roots.push(root)
  return join(root, 'host.sock')
}

/** Records frames, the close report, and log lines for one client. */
interface Sink {
  readonly frames: unknown[]
  readonly closes: string[]
  readonly log: string[]
}

/**
 * @param endpoint - host endpoint. @param sink - frame and close recorder.
 * @param options - token or handshake deadline overrides.
 * @returns client options.
 */
function clientOptions(
  endpoint: string,
  sink: Sink,
  options: { readonly token?: string; readonly handshakeTimeoutMs?: number } = {},
): SharedHostClientOptions {
  return {
    endpoint,
    token: options.token ?? TOKEN,
    clientId: 'window-a',
    extensionVersion: '0.0.0-test',
    configFingerprint: 'config-1',
    limits: DEFAULT_BRIDGE_LIMITS,
    onFrame: (frame) => { sink.frames.push(frame) },
    onClose: (reason) => { sink.closes.push(reason) },
    log: (line) => { sink.log.push(line) },
    ...options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs },
  }
}

/** One started host that echoes every frame back to its connection. */
interface HostFixture {
  readonly server: SharedHostServer
  readonly endpoint: string
  readonly disposed: string[]
}

/**
 * @param token - credential the host requires.
 * @returns the fixture.
 */
async function startHost(token = TOKEN): Promise<HostFixture> {
  const endpoint = uniqueEndpoint()
  const disposed: string[] = []
  const server = new SharedHostServer({
    endpoint,
    token,
    instanceId: 'instance-1',
    dshVersion: '0.2.2-alpha.2',
    configFingerprint: 'config-1',
    log: () => {},
    ...process.platform === 'win32' ? {} : { staleSocketPath: endpoint },
    createSession: async (hello, connection): Promise<HostSession> => {
      const name = `session:${hello.clientId}`
      return {
        ready: { session: name },
        handle: async (frame: unknown) => {
          connection.send({ type: 'echo', connection: connection.id, frame })
        },
        dispose: () => { disposed.push(name) },
      }
    },
  })
  await server.listen()
  servers.push(server)
  return { server, endpoint, disposed }
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

describe('connectSharedHost', () => {
  it('is admitted with the boot payload and keeps forwarding frames', async () => {
    const host = await startHost()
    const sink: Sink = { frames: [], closes: [], log: [] }
    const connection = await connectSharedHost(clientOptions(host.endpoint, sink))
    expect(connection.hello).toMatchObject({
      type: 'hello-ok',
      protocol: 1,
      instanceId: 'instance-1',
      connectionId: 'connection-1',
      dshVersion: '0.2.2-alpha.2',
      configFingerprint: 'config-1',
    })
    expect(connection.ready).toEqual({ session: 'session:window-a' })
    expect(connection.closed).toBe(false)

    connection.send({ type: 'fetch', id: 7, url: '/api/a' })
    await until(() => sink.frames.length === 1)
    expect(sink.frames[0]).toMatchObject({ type: 'echo', connection: 'connection-1' })

    connection.close()
    expect(connection.closed).toBe(true)
    expect(sink.closes).toEqual(['the window closed its connection'])
    await until(() => host.disposed.includes('session:window-a'))
  })

  it('reports a host refusal as a typed error', async () => {
    const host = await startHost('b'.repeat(64))
    const sink: Sink = { frames: [], closes: [], log: [] }
    const failure = connectSharedHost(clientOptions(host.endpoint, sink))
    await expect(failure).rejects.toBeInstanceOf(HostRefusedError)
    await expect(failure).rejects.toMatchObject({ code: 'token' })
    expect(host.disposed).toEqual([])
  })

  it('reports the transport ending after admission', async () => {
    const host = await startHost()
    const sink: Sink = { frames: [], closes: [], log: [] }
    const connection = await connectSharedHost(clientOptions(host.endpoint, sink))
    await host.server.close()
    await until(() => sink.closes.length === 1)
    expect(sink.closes[0]).toContain('closed the connection')
    expect(connection.closed).toBe(true)
    expect(host.disposed).toEqual(['session:window-a'])
  })

  it('gives up when the host never answers the handshake', async () => {
    const endpoint = uniqueEndpoint()
    // The host accepts the connection but never finishes preparing a session,
    // so no admission answer or boot payload can arrive.
    const silent = new SharedHostServer({
      endpoint,
      token: TOKEN,
      instanceId: 'instance-1',
      dshVersion: '0.2.2-alpha.2',
      configFingerprint: 'config-1',
      log: () => {},
      ...process.platform === 'win32' ? {} : { staleSocketPath: endpoint },
      createSession: () => new Promise<HostSession>(() => {}),
    })
    await silent.listen()
    servers.push(silent)
    const sink: Sink = { frames: [], closes: [], log: [] }
    await expect(connectSharedHost(clientOptions(endpoint, sink, { handshakeTimeoutMs: 50 })))
      .rejects.toThrow(/did not answer the handshake/u)
  })
})
