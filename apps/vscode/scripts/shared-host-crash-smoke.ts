/**
 * C9 lifecycle: kill the shared host, then restart it and reattach two windows.
 * Sessions, the installed bundle, and the settled install result must survive.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'
import { writePreparedBundle } from '../../../packages/boot/plugin-manager/tests/prepared-bundle.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-host-crash-'))
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const log = (line: string): void => { process.stderr.write(`${line}\n`) }
const failures: string[] = []

function check(condition: boolean, label: string): void {
  process.stdout.write(`${label}: ${String(condition)}\n`)
  if (!condition) failures.push(label)
}

interface Frame {
  readonly type?: string
  readonly id?: number
  readonly body?: string
}

/** One attached window with its own frame recorder. */
class Window {
  private nextId = 1

  constructor(readonly id: string, readonly bridge: Awaited<ReturnType<typeof attachSharedHost>>, readonly frames: Frame[]) {}

  static async attach(id: string): Promise<Window> {
    const frames: Frame[] = []
    const bridge = await attachSharedHost({
      endpoint: endpoint.endpoint,
      token,
      clientId: id,
      extensionVersion: '0.0.0-smoke',
      configFingerprint: 'host-crash',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: extensionPath,
      webview: { asUri: path => `uri:${path}`, postMessage: async (frame) => { frames.push(frame as Frame) } },
      log,
    })
    return new Window(id, bridge, frames)
  }

  async call(method: string, args: object = { _request: {} }): Promise<any> {
    const id = this.nextId++
    await this.bridge.handle({
      type: 'fetch',
      id,
      url: `api/${method}`,
      body: JSON.stringify({ type: 'client-request', rpcId: `${this.id}-${String(id)}`, method, payload: { args } }),
    })
    const frame = await waitFor(this.frames, item => item.type === 'fetch-result' && item.id === id, `${this.id} ${method}`)
    const body = JSON.parse(frame.body ?? '{}')
    return body?.result?.value
  }

  async close(): Promise<void> {
    await this.bridge.dispose()
  }
}

async function waitFor(frames: Frame[], predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
  const deadline = Date.now() + 120_000
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

const fixtureDir = join(storageDir, 'fixture-crash')
writePreparedBundle(fixtureDir, {
  name: 'dsh-c10-crash',
  version: '1.0.0',
  manifestExtra: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
  extraFiles: {
    'cordis.patch.yml': "- insert:\n    - id: c10-crash-tools\n      name: '@deepseek-ai/dsh-plugin-manager/tools'\n",
  },
})

const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: extensionPath,
  workspacePath: extensionPath,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'host-crash',
  idleExitMs: 120_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

let started = await startSharedHostProcess(hostOptions)
const hostPids: number[] = started.pid === undefined ? [] : [started.pid]
try {
  const a = await Window.attach('window-a')
  const b = await Window.attach('window-b')

  const first = await a.call('session/create', { request: {} })
  const second = await b.call('session/create', { request: {} })
  const sessionIds = [first?.sessionId, second?.sessionId].filter((id): id is string => typeof id === 'string')
  check(sessionIds.length === 2, 'two windows created two Sessions before the crash')

  const installRequest = randomUUID()
  const installed = await a.call('pluginManager/installBundle', { spec: fixtureDir, options: { requestId: installRequest } })
  check(installed?.changed === true && installed?.application === 'restart-required', 'a bundle is installed and pending before the crash')

  let beforeCrash: { application?: string } | null = null
  const settleDeadline = Date.now() + 10_000
  while (Date.now() <= settleDeadline && beforeCrash == null) {
    beforeCrash = await a.call('pluginManager/waitForInstall', { requestId: installRequest })
    if (beforeCrash == null) await new Promise(resolve => { setTimeout(resolve, 200) })
  }
  check(beforeCrash?.application === 'restart-required', 'the settled install result is queryable while the host is up')

  // Kill the host process: the windows must observe the transport ending.
  if (started.pid !== undefined) process.kill(started.pid)
  await new Promise(resolve => { setTimeout(resolve, 1_500) })
  let observed = false
  try {
    await a.call('session/list')
  } catch {
    observed = true
  }
  check(observed, 'the window observes the host ending')

  // Restart and reattach two fresh windows.
  started = await startSharedHostProcess(hostOptions)
  if (started.pid !== undefined) hostPids.push(started.pid)
  const c = await Window.attach('window-c')
  const d = await Window.attach('window-d')

  const listed = await c.call('session/list')
  check(
    Array.isArray(listed?.items) && sessionIds.every(id => listed.items.some(item => item.sessionId === id)),
    'both Sessions survive the host crash',
  )
  const bundles = await c.call('pluginManager/listBundles', {})
  check(Array.isArray(bundles) && bundles.some(row => row.name === 'dsh-c10-crash' && row.enabled === true),
    'the installed bundle survives the crash and is loaded')
  const pending = await c.call('pluginManager/pendingRestartBundles', {})
  check(Array.isArray(pending) && !pending.some(row => row.name === 'dsh-c10-crash'),
    'the restarted host reports no pending change for the loaded bundle')

  // The settled outcome is still queryable by request id after the restart,
  // while an unknown id answers null instead of guessing.
  const afterCrash = await c.call('pluginManager/waitForInstall', { requestId: installRequest })
  check(afterCrash?.application === 'restart-required' && afterCrash?.changed === true,
    'the settled install result survives the host restart')
  const unknown = await c.call('pluginManager/waitForInstall', { requestId: randomUUID() })
  check(unknown == null, 'an unknown install id answers null instead of guessing')

  await a.close()
  await b.close()
  await c.close()
  await d.close()
} catch (error) {
  process.stderr.write(`host crash smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  for (const pid of hostPids) {
    try {
      process.kill(pid)
    } catch {
      // An earlier crash or the idle exit already ended that process.
    }
  }
  rmSync(storageDir, { recursive: true, force: true })
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS host crash recovery: sessions, bundle, and install result survive\n')
  }
}
