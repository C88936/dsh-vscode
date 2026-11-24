/**
 * C10 acceptance on the real shared host: a prepared local bundle installed by
 * window A becomes visible to window B with its pending restart, a same-version
 * replacement is visible in every window and in a reopened page, a restart
 * clears the pending record, and removing the bundle again is seen by both.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'
import { writePreparedBundle } from '../../../packages/boot/plugin-manager/tests/prepared-bundle.ts'

const extensionPath = join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-shared-plugin-'))
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
  readonly item?: unknown
  readonly body?: string
  readonly status?: number
}

/** One attached window with its own frame recorder. */
class Window {
  private nextId = 1

  constructor(
    readonly id: string,
    readonly bridge: Awaited<ReturnType<typeof attachSharedHost>>,
    readonly frames: Frame[],
  ) {}

  static async attach(id: string): Promise<Window> {
    const frames: Frame[] = []
    const bridge = await attachSharedHost({
      endpoint: endpoint.endpoint,
      token,
      clientId: id,
      extensionVersion: '0.0.0-smoke',
      configFingerprint: 'plugin-smoke',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: extensionPath,
      webview: { asUri: path => `uri:${path}`, postMessage: async (frame) => { frames.push(frame as Frame) } },
      log,
    })
    return new Window(id, bridge, frames)
  }

  async call(method: string, args: object = { _request: {} }): Promise<any> {
    const raw = await this.callRaw(method, args)
    return raw?.value
  }

  async callRaw(method: string, args: object = { _request: {} }): Promise<any> {
    const id = this.nextId++
    await this.bridge.handle({
      type: 'fetch',
      id,
      url: `api/${method}`,
      body: JSON.stringify({ type: 'client-request', rpcId: `${this.id}-${String(id)}`, method, payload: { args } }),
    })
    const frame = await waitFor(this.frames, item => item.type === 'fetch-result' && item.id === id, `${this.id} ${method}`)
    const body = JSON.parse(frame.body ?? '{}')
    return body?.result
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

const fixtureDir = join(storageDir, 'fixture-bundle')
writePreparedBundle(fixtureDir, {
  name: 'dsh-c10-fixture',
  version: '1.0.0',
  manifestExtra: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
  extraFiles: { 'cordis.patch.yml': "- insert:\n    - id: c10-fixture-tools\n      name: '@deepseek-ai/dsh-plugin-manager/tools'\n" },
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
  configFingerprint: 'plugin-smoke',
  idleExitMs: 60_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

const startedHosts: { pid: number | undefined }[] = []
async function startHost(launchName: string): Promise<void> {
  startedHosts.push(await startSharedHostProcess({ ...hostOptions, launchDir: join(storageDir, 'launch', launchName) }))
}

const started = await startSharedHostProcess(hostOptions)
startedHosts.push(started)
try {
  const a = await Window.attach('window-a')
  const b = await Window.attach('window-b')
  const c = await Window.attach('window-c')

  const installed = await a.call('pluginManager/installBundle', { spec: fixtureDir })
  check(installed?.changed === true, 'window-a installs the prepared bundle')
  check(installed?.application === 'restart-required', 'the host reports the install needs a restart')

  const bundlesByB = await b.call('pluginManager/listBundles', {})
  check(Array.isArray(bundlesByB) && bundlesByB.some(row => row.name === 'dsh-c10-fixture'), 'window-b lists the installed bundle')

  const pendingByB = await b.call('pluginManager/pendingRestartBundles', {})
  process.stdout.write(`pending by b: ${JSON.stringify(pendingByB)}\n`)
  check(
    Array.isArray(pendingByB) && pendingByB.some(row => row.name === 'dsh-c10-fixture' && row.savedEnabled === true),
    'window-b sees the same pending restart',
  )

  await a.close()
  const pendingAfterClose = await b.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingAfterClose) && pendingAfterClose.some(row => row.name === 'dsh-c10-fixture'),
    'window-b keeps the pending restart after window-a closed',
  )

  const removed = await b.call('pluginManager/removeBundle', { name: 'dsh-c10-fixture' })
  check(removed?.changed === true, 'window-b removes the installed bundle')
  const bundlesAfter = await b.call('pluginManager/listBundles', {})
  check(!Array.isArray(bundlesAfter) || !bundlesAfter.some(row => row.name === 'dsh-c10-fixture'), 'the bundle is gone for the remaining window')

  // A tampered prepared bundle is refused before pnpm and both windows see the
  // same typed failure with no installed bundle.
  const brokenDir = join(storageDir, 'broken-bundle')
  writePreparedBundle(brokenDir, { name: 'dsh-c10-broken', version: '1.0.0' })
  writeFileSync(join(brokenDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const refusedByB = await b.call('pluginManager/installBundle', { spec: brokenDir })
  check(refusedByB?.application === 'failed' && refusedByB?.changed === false, 'window-b gets a failed install result')
  check(typeof refusedByB?.error?.code === 'string', 'the failure carries a typed error code')
  const refusedByC = await c.call('pluginManager/installBundle', { spec: brokenDir })
  check(refusedByC?.error?.code === refusedByB?.error?.code, 'both windows get the same failure code')
  const bundlesAfterFailure = await c.call('pluginManager/listBundles', {})
  check(!Array.isArray(bundlesAfterFailure) || !bundlesAfterFailure.some(row => row.name === 'dsh-c10-broken'), 'the failed install leaves no bundle')

  // Starting a window disconnecting must not cancel the accepted install; the
  // other window retrieves the settled result through waitForInstall.
  const disconnectRequest = 'c10-disconnect-request'
  await b.bridge.handle({
    type: 'fetch',
    id: 900,
    url: 'api/pluginManager/installBundle',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'disconnect-install',
      method: 'pluginManager/installBundle',
      payload: { args: { spec: fixtureDir, options: { requestId: disconnectRequest } } },
    }),
  })
  await b.close()
  let settled: { changed?: boolean; application?: string } | null = null
  const deadline = Date.now() + 180_000
  while (Date.now() <= deadline && settled == null) {
    settled = await c.call('pluginManager/waitForInstall', { requestId: disconnectRequest })
    if (settled == null) await new Promise(resolve => { setTimeout(resolve, 500) })
  }
  check(settled?.changed === true, 'the install settles after the starting window disconnected')
  const bundlesByC = await c.call('pluginManager/listBundles', {})
  check(Array.isArray(bundlesByC) && bundlesByC.some(row => row.name === 'dsh-c10-fixture'), 'the surviving window sees the settled install')
  const pendingByC = await c.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingByC) && pendingByC.some(row => row.name === 'dsh-c10-fixture'),
    'the surviving window sees the pending restart of the settled install',
  )
  const cleaned = await c.call('pluginManager/removeBundle', { name: 'dsh-c10-fixture' })
  check(cleaned?.changed === true, 'the surviving window removes the settled bundle')

  // A same-name, same-version replacement: the selection does not change, so
  // only the Host's revision record can tell every window and a reopened page
  // that the loaded code is behind the saved files.
  const replacedDir = join(storageDir, 'fixture-bundle-replaced')
  writePreparedBundle(replacedDir, {
    name: 'dsh-c10-fixture',
    version: '1.0.0',
    manifestExtra: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    extraFiles: {
      'cordis.patch.yml': "- insert:\n    - id: c10-fixture-tools\n      name: '@deepseek-ai/dsh-plugin-manager/tools'\n",
      'lib/replaced.txt': 'second version\n',
    },
  })
  const reinstalled = await c.call('pluginManager/installBundle', { spec: fixtureDir })
  check(reinstalled?.application === 'restart-required', 'the bundle installs again for the replacement check')
  const beforeReplace = await c.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(beforeReplace) && !beforeReplace.some(row => row.name === 'dsh-c10-fixture' && row.change === 'replaced'),
    'a fresh install is not reported as a replacement',
  )
  const replacedResult = await c.call('pluginManager/installBundle', { spec: replacedDir })
  process.stdout.write(`replacement result: ${JSON.stringify(replacedResult)}\n`)
  check(replacedResult?.changed === true, 'window-c saves the same-version replacement')
  const pendingAfterReplace = await c.call('pluginManager/pendingRestartBundles', {})
  const replacedRow = Array.isArray(pendingAfterReplace)
    ? pendingAfterReplace.find(row => row.name === 'dsh-c10-fixture')
    : undefined
  process.stdout.write(`replacement pending: ${JSON.stringify(replacedRow)}\n`)
  check(replacedRow?.change === 'replaced', 'the replacement is reported as a file change')
  check(typeof replacedRow?.savedRevision === 'string' && typeof replacedRow?.runningRevision === 'string',
    'the replacement carries the loaded and saved revisions')
  check(replacedRow?.savedRevision !== replacedRow?.runningRevision, 'the revisions differ after the replacement')

  // A page that reopens after the replacement reads the same fact from the Host.
  const reopened = await Window.attach('window-reopened')
  const pendingByReopened = await reopened.call('pluginManager/pendingRestartBundles', {})
  const reopenedRow = Array.isArray(pendingByReopened)
    ? pendingByReopened.find(row => row.name === 'dsh-c10-fixture')
    : undefined
  check(reopenedRow?.change === 'replaced', 'a reopened page sees the replacement pending restart')
  check(reopenedRow?.savedRevision === replacedRow?.savedRevision, 'the reopened page reports the same saved revision')
  await reopened.close()

  // A controlled maintenance restart loads the saved files and starts a fresh
  // manager, so the pending record is gone.
  const shutdown = await c.bridge.shutdownHost()
  check(shutdown.ok === true, 'the host accepts a maintenance restart after the replacement')
  await new Promise(resolve => { setTimeout(resolve, 500) })
  await startHost('smoke-restarted')
  const restartedWindow = await Window.attach('window-after-restart')
  const pendingAfterRestart = await restartedWindow.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingAfterRestart) && !pendingAfterRestart.some(row => row.name === 'dsh-c10-fixture'),
    'the restarted host loads the replacement and reports no pending change',
  )
  const bundlesAfterRestart = await restartedWindow.call('pluginManager/listBundles', {})
  check(
    Array.isArray(bundlesAfterRestart) && bundlesAfterRestart.some(row => row.name === 'dsh-c10-fixture' && row.enabled === true),
    'the restarted host lists the replaced bundle as loaded',
  )
  await restartedWindow.close()
  await c.close()
} catch (error) {
  process.stderr.write(`shared plugin smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  for (const host of startedHosts) {
    try {
      if (host.pid !== undefined) process.kill(host.pid)
    } catch {
      // The idle exit or a maintenance restart already ended the process.
    }
  }
  rmSync(storageDir, { recursive: true, force: true })
  if (failures.length > 0) {
    // The host log names why a request never answered; keep it in the failure report.
    try {
      const hostLog = existsSync(join(storageDir, 'runtime', 'host.log'))
        ? readFileSync(join(storageDir, 'runtime', 'host.log'), 'utf8').split('\n').slice(-40).join('\n')
        : '(no host log)'
      process.stdout.write(`host log tail:\n${hostLog}\n`)
    } catch {
      process.stdout.write('host log tail: unreadable\n')
    }
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS cross-window plugin install, replacement restart, failure, disconnect recovery, and removal\n')
  }
}
