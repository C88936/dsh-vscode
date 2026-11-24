/**
 * Two windows on one shared DSH host, driven through the extension-side bridge
 * against a real companion process: both windows see the same history entry,
 * the same workspace projection, one window closing does not disturb the other,
 * and a maintenance stop plus restart keeps the stored history.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { deepStrictEqual, rejects } from 'node:assert'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'
import type { SharedHostBridge } from '../src/host/shared-bridge.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-shared-windows-'))
const workspaceA = join(storageDir, 'workspace-a')
const workspaceB = join(storageDir, 'workspace-b')
mkdirSync(workspaceA)
mkdirSync(workspaceB)
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const log = (line) => process.stderr.write(`${line}\n`)
const failures = []

function check(condition, label) {
  process.stdout.write(`${label}: ${String(condition)}\n`)
  if (!condition) failures.push(label)
}

const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: workspaceA,
  workspacePath: workspaceA,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'windows-smoke',
  idleExitMs: 1_500,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

const pids = []

/** One attached window with its own frame recorder. */
class Window {
  constructor(id, bridge, frames) {
    this.id = id
    this.bridge = bridge
    this.frames = frames
    this.nextId = 1
  }

  static async attach(id, workspacePath = workspaceA) {
    const frames = []
    const bridge = await attachSharedHost({
      endpoint: endpoint.endpoint,
      token,
      clientId: id,
      extensionVersion: '0.0.0-smoke',
      configFingerprint: 'windows-smoke',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath,
      webview: {
        asUri: path => `uri:${path}`,
        postMessage: async (frame) => { frames.push(frame) },
      },
      log,
    })
    return new Window(id, bridge, frames)
  }

  async call(method, args = { _request: {} }) {
    const id = this.nextId++
    await this.bridge.handle({
      type: 'fetch',
      id,
      url: `api/${method}`,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `${this.id}-${String(id)}`,
        method,
        payload: { args },
      }),
    })
    const answer = await waitFor(this.frames, frame => frame.type === 'fetch-result' && frame.id === id, `${this.id} ${method}`)
    const body = JSON.parse(answer.body)
    return body?.result?.value
  }

  async followEvents() {
    const id = this.nextId++
    await this.bridge.handle({ type: 'stream-open', id, endpoint: '$events', payload: { args: {} } })
    return id
  }

  async waitForEvent(name) {
    const frame = await waitFor(
      this.frames,
      item => item.type === 'stream-item' && JSON.stringify(item.item).includes(name),
      `${this.id} ${name} event`,
    )
    return frame
  }

  async followWorkspace() {
    const id = this.nextId++
    await this.bridge.handle({ type: 'stream-open', id, endpoint: 'workspace/follow', payload: { args: {} } })
    const baseline = await waitFor(
      this.frames,
      frame => frame.type === 'stream-item' && frame.id === id && frame.item?.type === 'baseline',
      `${this.id} workspace baseline`,
    )
    return baseline.item.value
  }

  async followSession(sessionId) {
    const id = this.nextId++
    await this.bridge.handle({ type: 'stream-open', id, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId } } } } })
    const snapshot = await waitFor(this.frames,
      frame => frame.id === id && (frame.type === 'stream-end'
        || (frame.type === 'stream-item' && frame.item?.type === 'snapshot')),
      `${this.id} Session snapshot`)
    if (snapshot.type === 'stream-end') throw new Error(`Session follow failed: ${JSON.stringify(snapshot.error)}`)
    await this.bridge.handle({ type: 'stream-cancel', id })
    return snapshot.item
  }

  async close() {
    await this.bridge.dispose()
  }
}

async function waitFor(frames, predicate, label) {
  const deadline = Date.now() + 60_000
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

function sessionIdOf(value) {
  const items = value?.items ?? []
  return items[0]?.sessionId
}

function workspaceHasSession(value, sessionId) {
  return Array.isArray(value?.items)
    && value.items.some(workspace => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
}

const first = await startSharedHostProcess(hostOptions)
if (first.pid !== undefined) pids.push(first.pid)

try {
  const a = await Window.attach('window-a')
  const b = await Window.attach('window-b', workspaceB)
  check(a.bridge.hello.instanceId === b.bridge.hello.instanceId, 'both windows reached the same host instance')
  check(a.bridge.hello.connectionId !== b.bridge.hello.connectionId, 'the windows have distinct connection ids')

  const listedByA = await a.call('session/list')
  const sessionId = sessionIdOf(listedByA)
  check(typeof sessionId === 'string', 'window-a lists a stored session')
  const listedByB = await b.call('session/list')
  check(sessionIdOf(listedByB) === sessionId, 'window-b lists the same stored session')

  const projectionA = await a.followWorkspace()
  const projectionB = await b.followWorkspace()
  check(workspaceHasSession(projectionA, sessionId), 'window-a projects the stored session')
  check(workspaceHasSession(projectionB, sessionId), 'window-b projects the same stored session')

  const registeredA = projectionB.items.find(item => item.path === workspaceA)
  const registeredB = projectionB.items.find(item => item.path === workspaceB)
  check(registeredA !== undefined && registeredB !== undefined, 'both window folders are registered in the shared host')
  check(projectionA.items.length === 2 && projectionB.items.length === 2, 'both windows see both workspace registrations')
  if (registeredA === undefined || registeredB === undefined) throw new Error('a window folder was not registered')
  const initialA = registeredA.sessionIds[0]
  const initialB = registeredB.sessionIds[0]
  const createdA = await a.call('session/create', { request: { workspaceId: registeredA.workspaceId } })
  const createdB = await b.call('session/create', { request: { workspaceId: registeredB.workspaceId } })
  check(createdA.sessionId !== createdB.sessionId, 'each folder creates its own Session')
  const historiesA = await a.call('session/list')
  const historiesB = await b.call('session/list')
  const ids = [initialA, initialB, createdA.sessionId, createdB.sessionId]
  check(ids.every(id => historiesA.items.some(item => item.sessionId === id)
    && historiesB.items.some(item => item.sessionId === id)), 'both windows retain access to every Session')
  check([initialA, createdA.sessionId].every(id => historiesB.items.find(item => item.sessionId === id)?.cwd === workspaceA),
    'window-b reading window-a history preserves its original working directory')
  check([initialB, createdB.sessionId].every(id => historiesA.items.find(item => item.sessionId === id)?.cwd === workspaceB),
    'new window-b Sessions bind to window-b working directory')
  const viewedFromB = await b.followSession(createdA.sessionId)
  check(viewedFromB.header.cwd === workspaceA, 'window-b opens a window-a Session without rebinding its directory')
  await rejects(Window.attach('window-invalid', join(storageDir, 'missing-folder')))
  check((await b.followWorkspace()).items.length === 2, 'a refused invalid folder leaves the running Host and registrations usable')

  const aliases = await Promise.all([
    Window.attach('window-b-alias-1', `${workspaceB}/.`),
    Window.attach('window-b-alias-2', workspaceB),
  ])
  const afterAliases = await b.followWorkspace()
  check(afterAliases.items.length === 2
    && afterAliases.items.find(item => item.workspaceId === registeredB.workspaceId)?.sessionIds.length === 2,
  'concurrent reconnects reuse the Workspace and do not seed extra Sessions')
  await Promise.all(aliases.map(window => window.close()))

  const stateSnapshot = workspaceSnapshot(afterAliases, await b.call('session/list'))
  deepStrictEqual(stateSnapshot, JSON.parse(readFileSync(join(import.meta.dirname, '..', 'tests', 'expected', 'shared-workspaces.json'), 'utf8')))
  check(true, 'keyless shared Workspace and Session snapshot matches the expected output')

  // C10: a plugin change made through window A is broadcast to window B's
  // forwarded-event subscription, which is what makes the Plugins page refresh.
  await b.followEvents()
  const refusedChange = await a.call('pluginManager/setPluginEnabled', { id: 'no-such-plugin', enabled: true })
  check(refusedChange?.changed === false || refusedChange?.application === 'failed', 'the host records the refused plugin change')
  await b.waitForEvent('plugin-manager/changed')
  check(true, 'window-b receives the plugin change made by window-a')



  await a.close()
  await new Promise(resolve => { setTimeout(resolve, 500) })
  const listedByBAfterA = await b.call('session/list')
  check(ids.every(id => listedByBAfterA.items.some(item => item.sessionId === id)), 'window-b still lists all Sessions after window-a closed')
  const projectionBAfterA = await b.followWorkspace()
  check(workspaceHasSession(projectionBAfterA, sessionId), 'window-b still receives the projection after window-a closed')

  const activity = await b.bridge.activity(10_000)
  check(activity.runningTurns === 0, 'the shared host reports host-wide activity')
  const stopped = await b.bridge.shutdownHost()
  check(stopped.ok === true, 'window-b requests the shared maintenance stop')
  await new Promise(resolve => { setTimeout(resolve, 500) })
  await b.close()

  const second = await startSharedHostProcess(hostOptions)
  if (second.pid !== undefined) pids.push(second.pid)
  const recovered = await Window.attach('window-recovered')
  const listedAfterRestart = await recovered.call('session/list')
  check(ids.every(id => listedAfterRestart.items.some(item => item.sessionId === id)), 'all stored Sessions survive the shared restart')
  deepStrictEqual(workspaceSnapshot(await recovered.followWorkspace(), listedAfterRestart), stateSnapshot)
  check(true, 'workspace identities, membership and Session directories survive restart')
  await recovered.close()
} catch (error) {
  process.stderr.write(`shared windows smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // An idle exit already ended the process.
    }
  }
  try {
    rmSync(storageDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup of the smoke storage.
  }
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS two windows share history, projection, and recovery\n')
  }
}

/** Carrier output oracle over real Session records; volatile identities stay relational checks above. */
function workspaceSnapshot(workspaces, sessions) {
  return workspaces.items.map(workspace => ({
    directory: relative(storageDir, workspace.path).replaceAll('\\', '/'),
    sessions: workspace.sessionIds.map(id => {
      const session = sessions.items.find(item => item.sessionId === id)
      return { cwd: relative(storageDir, session.cwd).replaceAll('\\', '/'), blank: session.blank }
    }),
  })).sort((left, right) => left.directory.localeCompare(right.directory))
}
