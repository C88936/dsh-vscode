/**
 * The shared host listener: two real socket clients admitted as distinct
 * connections, per-connection reply routing, handshake refusals, and the idle
 * notification after the last window leaves.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SharedHostServer, type HostSession } from '../src/companion/server.ts'
import type { HostHello } from '../src/shared/host-protocol.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

/** One decoded frame from a test client. */
type Frame = Record<string, unknown>

/** Client driver over one real socket. */
interface TestClient {
  /** Every frame received so far, in order. */
  readonly frames: Frame[]
  send(frame: unknown): void
  close(): void
  /**
   * Resolve with the first frame matching the predicate.
   * @param predicate - frame filter. @param timeoutMs - maximum wait.
   */
  next(predicate: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>
}

/** Token every fixture host requires. */
const TOKEN = 'a'.repeat(64)

const roots: string[] = []
const clients: TestClient[] = []
const servers: SharedHostServer[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Create one endpoint name unique to a test.
 * @returns a named pipe or socket path.
 */
function uniqueEndpoint(): string {
  const suffix = `${String(process.pid)}-${Math.random().toString(16).slice(2, 10)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-vscode-test-${suffix}`
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  roots.push(root)
  return join(root, 'host.sock')
}

/**
 * @param endpoint - listener name.
 * @returns one connected test client.
 */
async function openClient(endpoint: string): Promise<TestClient> {
  const socket: Socket = connect(endpoint)
  const frames: Frame[] = []
  const listeners = new Set<(frame: Frame) => void>()
  let buffered = ''
  socket.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    while (true) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line === '') continue
      const frame = JSON.parse(line) as Frame
      frames.push(frame)
      for (const listener of [...listeners]) listener(frame)
    }
  })
  // A refused or closed connection is asserted through frames and timing; the
  // socket's own error must not become an unhandled event.
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => { resolve() })
    socket.once('error', (error: Error) => { reject(error) })
  })
  const client: TestClient = {
    frames,
    send(frame: unknown): void {
      socket.write(`${JSON.stringify(frame)}\n`)
    },
    close(): void {
      socket.destroy()
    },
    async next(predicate: (frame: Frame) => boolean, timeoutMs = 2_000): Promise<Frame> {
      const existing = frames.find(predicate)
      if (existing !== undefined) return existing
      return await new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener)
          reject(new Error('the expected frame did not arrive'))
        }, timeoutMs)
        const listener = (frame: Frame): void => {
          if (!predicate(frame)) return
          clearTimeout(timer)
          listeners.delete(listener)
          resolve(frame)
        }
        listeners.add(listener)
      })
    },
  }
  clients.push(client)
  return client
}

/**
 * @param token - host token. @param clientId - window identity. @param protocol - spoken version.
 * @returns one hello frame.
 */
function hello(token: string, clientId: string, protocol = 1): HostHello {
  return {
    type: 'hello',
    protocol,
    token,
    clientId,
    extensionVersion: '0.0.0-test',
    workspacePath: 'C:\\project',
    configFingerprint: 'config-1',
    limits: DEFAULT_BRIDGE_LIMITS,
  }
}

/** One started fixture host. */
interface Fixture {
  readonly server: SharedHostServer
  readonly endpoint: string
  readonly sessions: string[]
  readonly disposed: string[]
  readonly idle: number[]
  readonly log: string[]
}

/**
 * Start a host whose sessions echo every frame back to their own connection.
 * @param options - optional capacity or protocol overrides.
 * @returns the fixture.
 */
async function startHost(options: { readonly maxConnections?: number } = {}): Promise<Fixture> {
  const endpoint = uniqueEndpoint()
  const sessions: string[] = []
  const disposed: string[] = []
  const idle: number[] = []
  const log: string[] = []
  const server = new SharedHostServer({
    endpoint,
    token: TOKEN,
    instanceId: 'instance-1',
    dshVersion: '0.2.2-alpha.2',
    configFingerprint: 'config-1',
    log: line => { log.push(line) },
    ...options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections },
    ...process.platform === 'win32' ? {} : { staleSocketPath: endpoint },
    createSession: async (frame: HostHello, connection): Promise<HostSession> => {
      const name = `session:${frame.clientId}`
      sessions.push(name)
      return {
        ready: { session: name },
        handle: async (item: unknown) => {
          connection.send({ type: 'echo', connection: connection.id, frame: item })
        },
        dispose: () => { disposed.push(name) },
      }
    },
    onIdle: () => { idle.push(1) },
  })
  await server.listen()
  servers.push(server)
  return { server, endpoint, sessions, disposed, idle, log }
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

describe('SharedHostServer', () => {
  it('admits two windows as distinct connections with per-connection replies', async () => {
    const host = await startHost()
    const a = await openClient(host.endpoint)
    const b = await openClient(host.endpoint)
    a.send(hello(TOKEN, 'window-a'))
    b.send(hello(TOKEN, 'window-b'))
    const admittedA = await a.next(frame => frame.type === 'hello-ok')
    const admittedB = await b.next(frame => frame.type === 'hello-ok')
    expect(admittedA.connectionId).toBe('connection-1')
    expect(admittedB.connectionId).toBe('connection-2')
    expect(await a.next(frame => frame.type === 'ready')).toEqual({ type: 'ready', payload: { session: 'session:window-a' } })
    expect(await b.next(frame => frame.type === 'ready')).toEqual({ type: 'ready', payload: { session: 'session:window-b' } })
    expect(host.server.connectionCount).toBe(2)
    expect(host.sessions).toEqual(['session:window-a', 'session:window-b'])

    // Both windows use request id 7: the id spaces do not collide because each
    // connection has its own session and its reply goes back to its sender.
    a.send({ type: 'fetch', id: 7, url: '/api/a' })
    b.send({ type: 'fetch', id: 7, url: '/api/b' })
    const echoA = await a.next(frame => frame.type === 'echo')
    const echoB = await b.next(frame => frame.type === 'echo')
    expect(echoA.connection).toBe('connection-1')
    expect(echoA.frame).toEqual({ type: 'fetch', id: 7, url: '/api/a' })
    expect(echoB.connection).toBe('connection-2')
    expect(echoB.frame).toEqual({ type: 'fetch', id: 7, url: '/api/b' })
    expect(a.frames.filter(frame => frame.type === 'echo')).toHaveLength(1)
    expect(b.frames.filter(frame => frame.type === 'echo')).toHaveLength(1)
  })

  it('refuses a stale token before creating a session', async () => {
    const host = await startHost()
    const client = await openClient(host.endpoint)
    client.send(hello('b'.repeat(64), 'window-a'))
    const refusal = await client.next(frame => frame.type === 'hello-rejected')
    expect(refusal.code).toBe('token')
    expect(String(refusal.message)).toContain('access token is stale')
    expect(host.sessions).toEqual([])
    await until(() => host.server.connectionCount === 0)
  })

  it('refuses a client that speaks another protocol version', async () => {
    const host = await startHost()
    const client = await openClient(host.endpoint)
    client.send(hello(TOKEN, 'window-a', 99))
    const refusal = await client.next(frame => frame.type === 'hello-rejected')
    expect(refusal.code).toBe('protocol')
    expect(host.sessions).toEqual([])
  })

  it('refuses a first frame that is not a valid hello', async () => {
    const host = await startHost()
    const client = await openClient(host.endpoint)
    client.send({ type: 'fetch', id: 1 })
    const refusal = await client.next(frame => frame.type === 'hello-rejected')
    expect(refusal.code).toBe('protocol')
  })

  it('disposes only the closing window and reports idle after the last one', async () => {
    const host = await startHost()
    const a = await openClient(host.endpoint)
    const b = await openClient(host.endpoint)
    a.send(hello(TOKEN, 'window-a'))
    b.send(hello(TOKEN, 'window-b'))
    await a.next(frame => frame.type === 'ready')
    await b.next(frame => frame.type === 'ready')

    a.close()
    await until(() => host.disposed.includes('session:window-a'))
    expect(host.disposed).toEqual(['session:window-a'])
    expect(host.idle).toEqual([])
    expect(host.server.connectionCount).toBe(1)

    // The surviving window keeps its own session and answers on it.
    b.send({ type: 'stream-open', id: 3, endpoint: 'session.events', payload: {} })
    const echo = await b.next(frame => frame.type === 'echo')
    expect(echo.connection).toBe('connection-2')
    expect(host.disposed).toEqual(['session:window-a'])

    b.close()
    await until(() => host.idle.length === 1)
    expect(host.disposed).toEqual(['session:window-a', 'session:window-b'])
  })

  it('refuses a window beyond the configured connection capacity', async () => {
    const host = await startHost({ maxConnections: 1 })
    const a = await openClient(host.endpoint)
    a.send(hello(TOKEN, 'window-a'))
    await a.next(frame => frame.type === 'ready')
    const b = await openClient(host.endpoint)
    const refusal = await b.next(frame => frame.type === 'hello-rejected')
    expect(refusal.code).toBe('capacity')
    expect(host.sessions).toEqual(['session:window-a'])
  })
})
