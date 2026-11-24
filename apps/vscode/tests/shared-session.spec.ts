/**
 * Shared session factory over a real host listener: each window gets its own
 * peer, resource directory, and transport, while both are served by one
 * application context.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SharedHostServer } from '../src/companion/server.ts'
import { createSharedSessionFactory } from '../src/companion/session.ts'
import { connectSharedHost, type SharedHostConnection } from '../src/host/host-client.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const TOKEN = 'a'.repeat(64)
const roots: string[] = []
const servers: SharedHostServer[] = []
const connections: SharedHostConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a fresh temporary directory, removed after the test.
 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-session-'))
  roots.push(root)
  return root
}

/**
 * @returns a named pipe or socket path unique to one test.
 */
function uniqueEndpoint(): string {
  const suffix = `${String(process.pid)}-${Math.random().toString(16).slice(2, 10)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-session-test-${suffix}`
  return join(tempRoot(), 'host.sock')
}

/** Fake application context the session factory reads. */
interface Fixture {
  readonly ctx: unknown
  readonly peers: string[]
  readonly disposedPeers: string[]
  readonly injected: { readonly peer: string; readonly connection?: string }[]
  readonly connectedPeers: string[]
}

/**
 * @param injections - receives one entry per prepared page, naming its peer.
 * @returns the fixture context.
 */
function fixtureContext(injections: { peer: string; connection?: string }[]): Fixture {
  const peers: string[] = []
  const disposedPeers: string[] = []
  const connectedPeers: string[] = []
  let sequence = 0
  const ctx = {
    get: (name: string) => {
      if (name === 'connection') {
        return {
          browserPeer: { id: 'browser', principal: { kind: 'owner' } },
          createPeer: () => {
            const id = `peer-${String(++sequence)}`
            peers.push(id)
            return {
              id,
              principal: { kind: 'owner' },
              dispose: async () => { disposedPeers.push(id) },
            }
          },
        }
      }
      if (name === 'clientModules') {
        return {
          graph: () => ({ entries: [{ url: '/packages/example.js' }], batches: [] }),
          fetchBundle: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
          packageOf: () => undefined,
          packageAssetReferences: () => [],
        }
      }
      return undefined
    },
    emit: (_name: string, table: unknown[], peer: { id: string }) => {
      injections.push({ peer: peer.id })
      table.push({ kind: 'global' })
    },
  }
  return { ctx, peers, disposedPeers, injected: injections, connectedPeers }
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

describe('createSharedSessionFactory', () => {
  it('refuses an unregistered workspace before creating a peer or materializing resources', async () => {
    const root = tempRoot()
    const fixture = fixtureContext([])
    const factory = createSharedSessionFactory({
      ctx: fixture.ctx as never,
      shellRoot: join(root, 'shell'),
      connectionsDir: join(root, 'connections'),
      limits: DEFAULT_BRIDGE_LIMITS,
      log: () => {},
    })
    await expect(factory({
      type: 'hello', protocol: 1, token: TOKEN, clientId: 'window-a',
      extensionVersion: 'test', configFingerprint: 'test', limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: join(root, 'missing'),
    }, { id: 'connection-1', send: () => {}, close: () => {} }))
      .rejects.toThrow('ctx.workspaceRegistry is unavailable')
    expect(fixture.peers).toEqual([])
    expect(existsSync(join(root, 'connections'))).toBe(false)
  })

  it('gives each window its own peer, resource directory, and boot payload', async () => {
    const root = tempRoot()
    const shellRoot = join(root, 'shell')
    mkdirSync(shellRoot, { recursive: true })
    writeFileSync(join(shellRoot, 'index.html'), '<script type="module" src="/assets/shell.js"></script>')
    const connectionsDir = join(root, 'connections')
    const log: string[] = []
    const fixture = fixtureContext([])
    const endpoint = uniqueEndpoint()
    const server = new SharedHostServer({
      endpoint,
      token: TOKEN,
      instanceId: 'instance-1',
      dshVersion: '0.2.2-alpha.2',
      configFingerprint: 'config-1',
      log: line => { log.push(line) },
      ...process.platform === 'win32' ? {} : { staleSocketPath: endpoint },
      createSession: createSharedSessionFactory({
        ctx: fixture.ctx as never,
        shellRoot,
        connectionsDir,
        limits: DEFAULT_BRIDGE_LIMITS,
        log: line => { log.push(line) },
      }),
    })
    await server.listen()
    servers.push(server)

    const sink = { frames: [] as unknown[], closes: [] as string[] }
    const options = {
      endpoint,
      token: TOKEN,
      extensionVersion: '0.0.0-test',
      configFingerprint: 'config-1',
      limits: DEFAULT_BRIDGE_LIMITS,
      onFrame: (frame: unknown) => { sink.frames.push(frame) },
      onClose: (reason: string) => { sink.closes.push(reason) },
    }
    const first = await connectSharedHost({ ...options, clientId: 'window-a' })
    const second = await connectSharedHost({ ...options, clientId: 'window-b' })
    connections.push(first, second)

    expect(first.ready).toMatchObject({
      shell: join(shellRoot, 'assets', 'shell.js'),
      styles: [],
      assets: {},
      limits: DEFAULT_BRIDGE_LIMITS,
    })
    expect(fixture.injected.map(entry => entry.peer)).toEqual(['peer-1', 'peer-2'])
    const firstBundles = join(connectionsDir, 'connection-1', 'webview', 'bundles')
    const secondBundles = join(connectionsDir, 'connection-2', 'webview', 'bundles')
    expect(readdirSync(firstBundles)).toHaveLength(1)
    expect(readdirSync(secondBundles)).toHaveLength(1)

    // Both bridges share the application context, but a frame handled by one
    // window reaches only its own transport log.
    first.send({ type: 'log', line: 'from-window-a' })
    await until(() => log.includes('from-window-a'))

    first.close()
    await until(() => !existsSync(join(connectionsDir, 'connection-1')))
    expect(existsSync(join(connectionsDir, 'connection-2'))).toBe(true)
    expect(fixture.disposedPeers).toEqual(['peer-1'])

    second.close()
    await until(() => !existsSync(join(connectionsDir, 'connection-2')))
    await until(() => fixture.disposedPeers.length === 2)
  })
})
