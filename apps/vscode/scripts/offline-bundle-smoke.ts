/**
 * A5 acceptance on the real shared host: a prepared bundle whose dependency arrives as a tarball installs,
 * replaces, repairs, and loads on a machine with an empty store and no registry traffic.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const extensionPath = join(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'dsh-offline-bundle-'))
const storageDir = join(root, 'storage')
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const log = (line: string): void => { process.stderr.write(`${line}\n`) }
const failures: string[] = []
const startedHosts: { pid: number | undefined }[] = []
let registryRequests = 0

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
      configFingerprint: 'offline-smoke',
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
    return JSON.parse(frame.body ?? '{}')?.result
  }

  async close(): Promise<void> {
    await this.bridge.dispose()
  }
}

async function waitFor(frames: Frame[], predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
  const deadline = Date.now() + 240_000
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Write one file, creating its parent directories.
 * @param path - absolute target.
 * @param contents - text to write.
 */
function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/**
 * @param bytes - file bytes.
 * @returns pnpm's sha512 integrity string.
 */
function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/**
 * Pack a dependency with the runtime's pnpm so the tarball pnpm imports is a real one.
 * @param directory - dependency package directory.
 * @returns the tarball path.
 */
async function packDependency(directory: string): Promise<string> {
  const { execFileSync } = await import('node:child_process')
  const pnpm = join(extensionPath, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const output = execFileSync(process.execPath, [pnpm, 'pack', '--pack-destination', directory], {
    cwd: directory, encoding: 'utf8',
  })
  const file = output.trim().split('\n').at(-1)?.trim()
  if (file === undefined || !existsSync(join(directory, file))) throw new Error(`pnpm pack produced no tarball: ${output}`)
  return join(directory, file)
}

/**
 * Write one prepared bundle whose dependency comes from a tarball.
 * @param directory - bundle directory.
 * @param tarball - real dependency tarball.
 * @param marker - content that distinguishes two builds of the same version.
 * @returns the bundle's package name and the tarball integrity.
 */
function writeBundle(directory: string, tarball: string, marker: string): { name: string, integrity: string } {
  const name = 'dsh-offline-bundle'
  const version = '1.0.0'
  const depName = 'dsh-offline-dep'
  const depVersion = '1.0.0'
  const tarballBytes = readFileSync(tarball)
  const integrity = integrityOf(tarballBytes)
  const copied = join(directory, 'tarballs', `${depName}-${depVersion}.tgz`)
  mkdirSync(dirname(copied), { recursive: true })
  writeFileSync(copied, tarballBytes)
  write(join(directory, 'package.json'), JSON.stringify({
    name, version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { [depName]: depVersion },
  }))
  write(join(directory, 'cordis.patch.yml'), `# ${marker}\n- insert:\n    - id: offline-fixture-tools\n      name: '@deepseek-ai/dsh-plugin-manager/tools'\n`)
  write(join(directory, 'node_modules', depName, 'package.json'), JSON.stringify({ name: depName, version: depVersion }))
  write(join(directory, 'node_modules', depName, 'index.js'), `module.exports = ${JSON.stringify(marker)}\n`)
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      ${depName}:`,
    `        specifier: ${depVersion}`,
    `        version: ${depVersion}`,
    '',
    'packages:',
    '',
    `  ${depName}@${depVersion}:`,
    `    resolution: {integrity: ${integrity}}`,
    '',
    'snapshots:',
    '',
    `  ${depName}@${depVersion}: {}`,
    '',
  ].join('\n')
  write(join(directory, 'pnpm-lock.yaml'), lockfile)
  write(join(directory, 'dsh-prepared-bundle.json'), JSON.stringify({
    format: 'dsh-prepared-bundle/v1',
    name,
    version,
    lockfile: { path: 'pnpm-lock.yaml', sha256: createHash('sha256').update(lockfile).digest('hex') },
    hostProvided: [],
    packages: [{ name: depName, version: depVersion, path: `node_modules/${depName}`, integrity }],
    tarballs: [{ name: depName, version: depVersion, file: `tarballs/${depName}-${depVersion}.tgz`, integrity }],
    installScripts: [],
    native: [],
  }))
  return { name, integrity }
}

/**
 * @param directory - storage root.
 * @returns the profile's prepared store, when the install created one.
 */
function findPreparedStore(directory: string): string | undefined {
  const profiles = join(directory, 'profile')
  if (existsSync(join(profiles, '.dsh-store'))) return join(profiles, '.dsh-store')
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    const candidate = join(directory, entry, '.dsh-store')
    if (existsSync(join(directory, entry, 'package.json')) && existsSync(candidate)) return candidate
  }
  return undefined
}

const registry = createServer((_request, response) => {
  registryRequests++
  response.statusCode = 500
  response.end('offline smoke: this registry must not be reached')
})
await new Promise<void>((resolve) => { registry.listen(0, '127.0.0.1', () => { resolve() }) })
const registryUrl = `http://127.0.0.1:${String((registry.address() as AddressInfo).port)}/`

const dependencyDir = join(root, 'dep')
write(join(dependencyDir, 'package.json'), JSON.stringify({ name: 'dsh-offline-dep', version: '1.0.0', main: 'index.js' }))
write(join(dependencyDir, 'index.js'), 'module.exports = "dependency"\n')
const tarball = await packDependency(dependencyDir)
const first = join(root, 'bundle-v1')
const firstBundle = writeBundle(first, tarball, 'first')
const second = join(root, 'bundle-v2')
writeBundle(second, tarball, 'second')

const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'offline-smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: extensionPath,
  workspacePath: extensionPath,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'offline-smoke',
  idleExitMs: 60_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  runtimePath: join(extensionPath, 'runtime'),
  env: { npm_config_registry: registryUrl },
}
startedHosts.push(await startSharedHostProcess(hostOptions))

try {
  const window = await Window.attach('window-offline')
  const installed = await window.call('pluginManager/installBundle', { spec: first })
  process.stdout.write(`install result: ${JSON.stringify(installed)}\n`)
  check(installed?.changed === true, 'the tarball-delivered bundle installs')
  check(installed?.application === 'restart-required', 'the install needs a restart')
  check(installed?.prepared?.offline === 'proven', 'the closure is proven offline')

  const store = findPreparedStore(storageDir)
  check(store !== undefined, 'the install created a profile-owned store for the imported tarballs')
  const pending = await window.call('pluginManager/pendingRestartBundles', {})
  check(Array.isArray(pending) && pending.some(row => row.name === firstBundle.name), 'the installed bundle waits for a restart')

  const replaced = await window.call('pluginManager/installBundle', { spec: second })
  check(replaced?.changed === true, 'the same-version replacement installs from the same tarball')
  const pendingAfterReplace = await window.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingAfterReplace) && pendingAfterReplace.some(row => row.name === firstBundle.name && row.change === 'replaced'),
    'the replacement is reported as a file change',
  )

  const repaired = await window.call('pluginManager/repairBundle', { name: firstBundle.name })
  process.stdout.write(`repair result: ${JSON.stringify(repaired)}\n`)
  // The recorded dependency is the delivered link; the repair reinstalls from that package and its tarball.
  check(repaired?.status === 'repaired', 'the offline repair reinstalls the prepared package')
  check(repaired?.recordedVersion === '1.0.0' && repaired?.installedVersion === '1.0.0', 'the repair restores the recorded version')
  const pendingAfterRepair = await window.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingAfterRepair) && pendingAfterRepair.some(row => row.name === firstBundle.name && row.change === 'replaced'),
    'the repair waits for a restart as a file change',
  )

  // A controlled restart loads the saved bundle; the pending record clears.
  const shutdown = await window.bridge.shutdownHost()
  check(shutdown.ok === true, 'the host accepts a maintenance restart')
  await new Promise(resolve => { setTimeout(resolve, 500) })
  startedHosts.push(await startSharedHostProcess({ ...hostOptions, launchDir: join(storageDir, 'launch', 'offline-smoke-restarted') }))
  const afterRestart = await Window.attach('window-offline-restarted')
  const pendingAfterRestart = await afterRestart.call('pluginManager/pendingRestartBundles', {})
  check(
    Array.isArray(pendingAfterRestart) && !pendingAfterRestart.some(row => row.name === firstBundle.name),
    'the restarted host reports no pending change',
  )
  const bundles = await afterRestart.call('pluginManager/listBundles', {})
  check(
    Array.isArray(bundles) && bundles.some(row => row.name === firstBundle.name && row.enabled === true),
    'the restarted host lists the bundle as loaded',
  )
  const plugins = await afterRestart.call('pluginManager/listPlugins', {})
  check(
    Array.isArray(plugins) && plugins.some(row => String(row.entryId).endsWith('offline-fixture-tools')),
    'the loaded bundle contributes its row',
  )
  await afterRestart.close()
  await window.close()
  check(registryRequests === 0, 'no request reached the configured registry')
} catch (error) {
  process.stderr.write(`offline bundle smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  for (const host of startedHosts) {
    try {
      if (host.pid !== undefined) process.kill(host.pid)
    } catch {
      // The maintenance restart or idle exit already ended the process.
    }
  }
  await new Promise<void>((resolve) => { registry.close(() => { resolve() }) })
  rmSync(root, { recursive: true, force: true })
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS offline bundle install, replacement, repair, restart, and zero registry requests\n')
  }
}
