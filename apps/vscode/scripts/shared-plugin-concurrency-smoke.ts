/**
 * C10 concurrency and cancellation on the real shared host: two windows install
 * different bundles at the same time (serialized by the host gate), then one
 * window cancels an install started by the other.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'
import { writePreparedBundle } from '../../../packages/boot/plugin-manager/tests/prepared-bundle.ts'
import { withFileLock } from '../../../packages/util/atomic-write/src/index.ts'
import { startMockLlmServer } from '../../../packages/test-support/llm-mock-server/src/index.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-concurrency-'))
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
  readonly status?: number
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
      configFingerprint: 'plugin-concurrency',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: extensionPath,
      webview: { asUri: path => `uri:${path}`, postMessage: async (frame) => { frames.push(frame as Frame) } },
      log,
    })
    return new Window(id, bridge, frames)
  }

  async call(method: string, args: object = { _request: {} }): Promise<any> {
    const id = this.nextId++
    return await this.request(id, method, args)
  }

  async request(id: number, method: string, args: object): Promise<any> {
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

  send(id: number, method: string, args: object): void {
    void this.bridge.handle({
      type: 'fetch',
      id,
      url: `api/${method}`,
      body: JSON.stringify({ type: 'client-request', rpcId: `${this.id}-${String(id)}`, method, payload: { args } }),
    })
  }

  async close(): Promise<void> {
    await this.bridge.dispose()
  }
}

async function waitFor(frames: Frame[], predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
  const deadline = Date.now() + 180_000
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * @param name - bundle name.
 * @param directory - fixture directory.
 */
function fixture(name: string, directory: string): void {
  writePreparedBundle(directory, {
    name,
    version: '1.0.0',
    manifestExtra: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    extraFiles: {
      'cordis.patch.yml': `- insert:\n    - id: ${name}-tools\n      name: '@deepseek-ai/dsh-plugin-manager/tools'\n`,
    },
  })
}

const fixtureA = join(storageDir, 'fixture-a')
const fixtureB = join(storageDir, 'fixture-b')
const fixtureCancel = join(storageDir, 'fixture-cancel')
const fixtureDisconnect = join(storageDir, 'fixture-disconnect')
fixture('dsh-c10-a', fixtureA)
fixture('dsh-c10-b', fixtureB)
fixture('dsh-c10-cancel', fixtureCancel)
fixture('dsh-c10-disconnect', fixtureDisconnect)

const trigger = join(storageDir, 'internal-turn.json')
const observed = join(storageDir, 'internal-turn-end.json')
const probe = join(storageDir, 'internal-turn.mjs')
const overlay = join(storageDir, 'internal-turn.yml')
writeFileSync(probe, `
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
export const name = 'c10-internal-turn-smoke'
export const inject = ['sessionController', 'pluginManager']
export function apply(ctx) {
  let sessionId
  ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'turn/end') {
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify(event.data.reason))
    }
  })
  ctx.on('plugin-manager/operation', async (operation) => {
    if (operation.phase !== 'started' || !existsSync(${JSON.stringify(trigger)})) return
    sessionId = JSON.parse(readFileSync(${JSON.stringify(trigger)}, 'utf8'))
    unlinkSync(${JSON.stringify(trigger)})
    try {
      await ctx.sessionController.prompt({
        requestId: 'c10-internal-maintenance-smoke', sessionId, mode: 'queue',
        content: [{ type: 'text', text: 'Host-originated turn during maintenance.' }],
      }, new AbortController().signal)
    } catch (error) {
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ error: String(error) }))
    }
  })
}
`)
writeFileSync(overlay, `- insert:\n    - id: c10-internal-turn-smoke\n      name: '${pathToFileURL(probe).href}'\n`)
const mock = await startMockLlmServer({ port: 0, sequence: ['success'], repeatLast: true })
const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  extraOverlays: [overlay],
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: extensionPath,
  workspacePath: extensionPath,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'plugin-concurrency',
  idleExitMs: 120_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  env: { DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key' },
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

const started = await startSharedHostProcess(hostOptions)
try {
  const d = await Window.attach('window-d')
  const e = await Window.attach('window-e')

  // Two windows submit module operations at the same time; the host gate
  // serializes them and both must settle.
  const [installedA, installedB] = await Promise.all([
    d.call('pluginManager/installBundle', { spec: fixtureA }),
    e.call('pluginManager/installBundle', { spec: fixtureB }),
  ])
  check(installedA?.changed === true, 'window-d installs its bundle while window-e installs another')
  check(installedB?.changed === true, 'window-e installs its bundle while window-d installs another')
  const bothBundles = await e.call('pluginManager/listBundles', {})
  check(
    Array.isArray(bothBundles)
      && bothBundles.some(row => row.name === 'dsh-c10-a')
      && bothBundles.some(row => row.name === 'dsh-c10-b'),
    'the window sees both concurrently submitted installs',
  )
  await e.call('pluginManager/removeBundle', { name: 'dsh-c10-a' })
  await e.call('pluginManager/removeBundle', { name: 'dsh-c10-b' })

  // One window cancels an install the other started.
  const cancelRequest = 'c10-cancel-request'
  d.send(500, 'pluginManager/installBundle', { spec: fixtureCancel, options: { requestId: cancelRequest } })
  const cancellation = await e.call('pluginManager/cancelInstall', { requestId: cancelRequest })
  process.stdout.write(`cancellation status: ${JSON.stringify(cancellation)}\n`)
  check(cancellation?.status === 'cancelled' || cancellation?.status === 'too-late', 'the host answers the cancellation')

  // The starting window receives the settled ChangeResult for its own request.
  const settledFrame = await waitFor(d.frames, item => item.type === 'fetch-result' && item.id === 500, 'window-d install result')
  const settled = JSON.parse(settledFrame.body ?? '{}')?.result?.value
  process.stdout.write(`cancel settled: ${JSON.stringify(settled)}\n`)
  check(settled?.application === 'cancelled' || settled?.application === 'restart-required',
    'the install settles as cancelled or completed')
  const bundlesAfterCancel = await e.call('pluginManager/listBundles', {})
  const cancelInstalled = Array.isArray(bundlesAfterCancel) && bundlesAfterCancel.some(row => row.name === 'dsh-c10-cancel')
  if (settled?.application === 'cancelled') {
    check(cancelInstalled === false, 'a cancelled install leaves no bundle')
  } else {
    check(cancelInstalled === true, 'a too-late cancellation leaves the completed install')
    await e.call('pluginManager/removeBundle', { name: 'dsh-c10-cancel' })
  }
  const disconnectedRequest = 'c10-disconnected-install'
  const { sessionId } = await e.call('session/create', { request: { cwd: extensionPath } })
  await e.call('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  const locked = Promise.withResolvers<void>()
  const unlock = Promise.withResolvers<void>()
  const hold = withFileLock(join(storageDir, 'profile', 'package.json'), async () => {
    locked.resolve()
    await unlock.promise
  }, { waitMs: 5_000 })
  try {
    await Promise.race([locked.promise, hold])
    writeFileSync(trigger, JSON.stringify(sessionId))
    d.send(503, 'pluginManager/installBundle', { spec: fixtureDisconnect, options: { requestId: disconnectedRequest } })
    const startDeadline = Date.now() + 5_000
    let inFlight = false
    while (Date.now() < startDeadline) {
      inFlight = (await e.bridge.activity()).packageOperations > 0
      if (inFlight) break
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }
    if (!inFlight) throw new Error('install did not start while its package lock was held')
    await d.close()
    e.send(504, 'session/prompt', { request: {} })
    const refused = await waitFor(e.frames, item => item.type === 'fetch-result' && item.id === 504, 'prompt during a disconnected install')
    check(refused.status === 409 && refused.body?.includes('session/maintenance') === true,
      'a disconnected installer still holds turn admission while its operation is running')
    const turnDeadline = Date.now() + 10_000
    while (!existsSync(observed) && Date.now() < turnDeadline) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }
    const reason = existsSync(observed) ? JSON.parse(readFileSync(observed, 'utf8')) : undefined
    check(reason?.kind === 'blocked' && mock.requests.length === 0, 'a Host-originated turn is blocked before model execution during maintenance')
    if (reason?.kind !== 'blocked') log(`internal turn outcome: ${JSON.stringify(reason)}`)
  } finally {
    unlock.resolve()
    await hold
  }
  const detachedResult = await e.call('pluginManager/waitForInstall', { requestId: disconnectedRequest })
  check(detachedResult?.application === 'restart-required' && detachedResult.bundle === 'dsh-c10-disconnect',
    'the observer reads the settled outcome of the disconnected install')
  const reopened = await e.call('session/prompt', { request: {
    requestId: 'c10-observer-after-maintenance', sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Window turn after maintenance.' }],
  } })
  const finished = await e.call('session/wait', { request: { sessionId, timeoutMs: 30_000 } })
  check(reopened?.accepted === true && finished?.reason === 'idle' && mock.requests.length > 0,
    'the observer prompt reaches the model after package settlement')
  await e.call('pluginManager/removeBundle', { name: 'dsh-c10-disconnect' })
  await e.close()
} catch (error) {
  process.stderr.write(`plugin concurrency smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  try {
    if (started.pid !== undefined) process.kill(started.pid)
  } catch {
    // The idle exit or a maintenance restart already ended the process.
  }
  await mock.close()
  rmSync(storageDir, { recursive: true, force: true })
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS cross-window installs, cancellation and disconnect recovery\n')
  }
}
