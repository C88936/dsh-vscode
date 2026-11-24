/**
 * Starting the shared host: a detached child is spawned, its endpoint is
 * awaited, a window attaches through the same protocol, and a child that dies
 * before listening or never listens is reported instead of waiting forever.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const TOKEN = 'a'.repeat(64)
const roots: string[] = []
const pids: number[] = []

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // A child that already exited needs no cleanup.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a fresh temporary directory, removed after the test.
 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-process-'))
  roots.push(root)
  return root
}

/**
 * @returns a named pipe or socket path unique to one test.
 */
function uniqueEndpoint(): string {
  const suffix = `${String(process.pid)}-${Math.random().toString(16).slice(2, 10)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-shared-process-${suffix}`
  return join(tempRoot(), 'host.sock')
}

/** One fake companion installation. */
interface FakeInstall {
  readonly extensionPath: string
  readonly storageDir: string
  readonly launchDir: string
}

/**
 * Write a fake `lib/companion.cjs` that speaks the serve protocol.
 * @param script - the script body.
 * @returns the fake installation paths.
 */
function install(script: string): FakeInstall {
  const root = tempRoot()
  const extensionPath = join(root, 'extension')
  const storageDir = join(root, 'storage')
  mkdirSync(join(extensionPath, 'lib'), { recursive: true })
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(extensionPath, 'lib', 'companion.cjs'), script)
  return { extensionPath, storageDir, launchDir: join(storageDir, 'launch', 'window') }
}

/** A fake host that admits one hello and returns a minimal boot payload. */
const LISTENING_HOST = `
const net = require('node:net')
const options = JSON.parse(process.argv[2])
const serve = options.serve
const server = net.createServer(socket => {
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const frame = JSON.parse(line)
      if (frame.type !== 'hello') continue
      socket.write(JSON.stringify({ type: 'hello-ok', protocol: frame.protocol, instanceId: 'fake', connectionId: 'connection-1', dshVersion: 'fake', configFingerprint: serve.configFingerprint }) + '\\n')
      socket.write(JSON.stringify({ type: 'ready', payload: { injections: [], assets: {}, shell: '/shell.js', styles: [], limits: frame.limits } }) + '\\n')
    }
  })
})
server.listen(serve.endpoint)
setInterval(() => {}, 1000)
`

/**
 * @param options - start inputs.
 * @returns the start call.
 */
function startOptions(installPaths: FakeInstall, endpoint: string, extra: { readonly startTimeoutMs?: number } = {}) {
  return {
    extensionPath: installPaths.extensionPath,
    storageDir: installPaths.storageDir,
    launchDir: installPaths.launchDir,
    overlayPath: join(installPaths.extensionPath, 'profile', 'vscode.patch.yml'),
    shellRoot: join(installPaths.extensionPath, 'dist'),
    // The child must not use the temporary install directory as its working
    // directory: Windows keeps that directory locked until the child exits.
    cwd: process.cwd(),
    endpoint,
    token: TOKEN,
    connectionsDir: join(installPaths.storageDir, 'connections'),
    configFingerprint: 'config-1',
    limits: DEFAULT_BRIDGE_LIMITS,
    log: () => {},
    ...extra,
  }
}

describe('startSharedHostProcess', () => {
  it('spawns a detached host, waits for its endpoint, and admits a window', async () => {
    const installPaths = install(LISTENING_HOST)
    const endpoint = uniqueEndpoint()
    const started = await startSharedHostProcess(startOptions(installPaths, endpoint))
    if (started.pid !== undefined) pids.push(started.pid)
    expect(typeof started.pid).toBe('number')

    const bridge = await attachSharedHost({
      endpoint,
      token: TOKEN,
      clientId: 'window-a',
      extensionVersion: '0.0.0-test',
      configFingerprint: 'config-1',
      limits: DEFAULT_BRIDGE_LIMITS,
      webview: { asUri: path => `uri:${path}`, postMessage: async () => true },
      log: () => {},
    })
    const payload = await bridge.prepare('/unused')
    expect(payload.shell).toBe('uri:/shell.js')
    await bridge.dispose()
  })

  it('reports a child that exits before listening', async () => {
    const installPaths = install('process.exit(3)\n')
    const endpoint = uniqueEndpoint()
    await expect(startSharedHostProcess(startOptions(installPaths, endpoint, { startTimeoutMs: 5_000 })))
      .rejects.toThrow(/exited during startup \(code 3/u)
  })

  it('reports a child that never listens', async () => {
    const installPaths = install('setInterval(() => {}, 1000)\n')
    const endpoint = uniqueEndpoint()
    await expect(startSharedHostProcess(startOptions(installPaths, endpoint, { startTimeoutMs: 500 })))
      .rejects.toThrow(/did not listen/u)
  })

  it('rejects an attach without a reachable host', async () => {
    await expect(attachSharedHost({
      endpoint: uniqueEndpoint(),
      token: TOKEN,
      clientId: 'window-a',
      extensionVersion: '0.0.0-test',
      configFingerprint: 'config-1',
      limits: DEFAULT_BRIDGE_LIMITS,
      webview: { asUri: path => path, postMessage: async () => true },
      log: () => {},
    })).rejects.toThrow(/not reachable/u)
  })
})
