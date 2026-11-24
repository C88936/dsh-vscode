/**
 * C9 same-Session admission: a second window's prompt to a Session that is
 * already running is queued by the Session controller instead of starting a
 * second executor, and the shared host never reports more than one running turn.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '../../../packages/test-support/llm-mock-server/src/index.ts'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-session-queue-'))
const workspace = join(storageDir, 'workspace')
mkdirSync(workspace)
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
      configFingerprint: 'session-queue',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: workspace,
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
    return JSON.parse(frame.body ?? '{}')?.result?.value
  }

  async openFollow(sessionId: string): Promise<{ readonly items: () => unknown[]; cancel(): Promise<void> }> {
    const id = this.nextId++
    await this.bridge.handle({
      type: 'stream-open',
      id,
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, activate: true } } },
    })
    return {
      items: () => this.frames.filter(frame => frame.type === 'stream-item' && frame.id === id).map(frame => frame.item),
      cancel: async () => { await this.bridge.handle({ type: 'stream-cancel', id }) },
    }
  }

  async close(): Promise<void> {
    await this.bridge.dispose()
  }
}

async function waitFor(frames: Frame[], predicate: (frame: Frame) => boolean, label: string, timeoutMs = 120_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitUntil(checkFn: () => boolean, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (checkFn()) return
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

const mock = await startMockLlmServer({
  port: 0,
  sequence: ['slow_success'],
  repeatLast: true,
  successText: `PONG ${'streaming-token '.repeat(30)}END-OF-STREAM`,
  chunkDelayMs: 40,
})

const started = await startSharedHostProcess({
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'session-queue-smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: workspace,
  workspacePath: workspace,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'session-queue',
  idleExitMs: 60_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  runtimePath: join(extensionPath, 'runtime'),
  env: { DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key' },
  modelConfig: { provider: 'company', model: 'qwen-max', configured: true },
})

try {
  const a = await Window.attach('window-a')
  const b = await Window.attach('window-b')
  const created = await a.call('session/create', { request: { cwd: workspace } })
  const sessionId = String(created?.sessionId ?? '')
  check(sessionId.length > 0, 'window-a creates the shared Session')
  const selected = await a.call('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  check(selected?.selected?.model === 'deepseek-flash', 'window-a selects the mock model')

  const follow = await b.openFollow(sessionId)
  await waitUntil(() => follow.items().length > 0, 'window-b follow readiness', 30_000)

  const first = await a.call('session/prompt', {
    request: { requestId: 'queue-smoke-1', sessionId, mode: 'queue', content: [{ type: 'text', text: 'C9 first queued prompt.' }] },
  })
  check(first?.accepted === true, 'window-a prompt is accepted')
  const firstMarker = 'C9 first queued prompt.'
  const secondMarker = 'C9 second queued prompt.'
  const requestsFor = (marker: string) => mock.requests.filter(request => JSON.stringify(request.body).includes(marker))
  await waitUntil(() => requestsFor(firstMarker).some(request => request.outcome === undefined),
    'the first model response is still streaming', 60_000)

  // A second window prompts the same Session while it runs. Queue mode must
  // enter the inbox instead of starting a second executor.
  const second = await b.call('session/prompt', {
    request: { requestId: 'queue-smoke-2', sessionId, mode: 'queue', content: [{ type: 'text', text: 'C9 second queued prompt.' }] },
  })
  check(second?.accepted === true, 'window-b prompt to the running Session is accepted')

  let maximumRunning = 0
  const observeDeadline = Date.now() + 2_000
  while (Date.now() < observeDeadline) {
    const activity = await a.bridge.activity()
    maximumRunning = Math.max(maximumRunning, activity.runningTurns)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  check(maximumRunning === 1, 'the host never runs two turns for the same Session')

  await waitUntil(() => requestsFor(secondMarker).some(request => JSON.stringify(request.body).includes('END-OF-STREAM')),
    'the queued prompt reaches the model with the completed first reply')
  const idle = await b.call('session/wait', { request: { sessionId, timeoutMs: 30_000 } })
  check(idle?.reason === 'idle' && requestsFor(secondMarker).some(request => request.outcome === 'completed'),
    'the queued prompt completes a model invocation and the Session returns to idle')
  const text = follow.items().map(item => JSON.stringify(item)).join('\n')
  check(text.includes('END-OF-STREAM'), 'window-b receives the assistant output for the shared Session')
  await follow.cancel()

  // Steering: while a turn runs, another window's `steer` prompt enters the
  // running turn instead of waiting for it; the next model request carries it.
  const steerSession = await a.call('session/create', { request: { cwd: extensionPath } })
  const steerId = String(steerSession?.sessionId ?? '')
  check(steerId.length > 0, 'window-a creates a Session for steering')
  const steerSelected = await a.call('session/selectModel', { request: { sessionId: steerId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  check(steerSelected?.selected?.model === 'deepseek-flash', 'window-a selects the mock model for steering')
  const steerFollow = await b.openFollow(steerId)
  await waitUntil(() => steerFollow.items().length > 0, 'window-b steering follow readiness', 30_000)
  const steerFirst = await a.call('session/prompt', {
    request: { requestId: 'steer-smoke-1', sessionId: steerId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly PONG.' }] },
  })
  check(steerFirst?.accepted === true, 'window-a starts the turn that will be steered')
  await waitUntil(() => steerFollow.items().length >= 2, 'window-b observes the steering turn', 60_000)
  const steered = await b.call('session/prompt', {
    request: { requestId: 'steer-smoke-2', sessionId: steerId, mode: 'steer', content: [{ type: 'text', text: 'STEER-MARKER: include this instruction.' }] },
  })
  check(steered?.accepted === true, 'window-b steers the running turn')
  let steerDelivered = false
  const steerDeadline = Date.now() + 120_000
  while (Date.now() < steerDeadline) {
    if (mock.requests.some(record => JSON.stringify(record.body).includes('STEER-MARKER'))) { steerDelivered = true; break }
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  check(steerDelivered, 'the running turn receives the steering message in a model request')
  const steerActivity = await a.bridge.activity()
  check(steerActivity.runningTurns === 1, 'the steered turn is still the only running turn')
  await steerFollow.cancel()

  // Stopping: one window cancels a running turn; both windows observe the
  // Session return to idle, and no further model request is made for it.
  const cancelSession = await a.call('session/create', { request: { cwd: extensionPath } })
  const cancelId = String(cancelSession?.sessionId ?? '')
  await a.call('session/selectModel', { request: { sessionId: cancelId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  const cancelFollow = await b.openFollow(cancelId)
  await waitUntil(() => cancelFollow.items().length > 0, 'window-b cancel follow readiness', 30_000)
  const cancelPrompt = await a.call('session/prompt', {
    request: { requestId: 'cancel-smoke-1', sessionId: cancelId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly PONG.' }] },
  })
  check(cancelPrompt?.accepted === true, 'window-a starts the turn to be stopped')
  await waitUntil(() => cancelFollow.items().length >= 2, 'window-b observes the turn to stop', 60_000)
  const cancelled = await b.call('session/cancel', { request: { sessionId: cancelId } })
  check(cancelled?.accepted === true, 'window-b stops the running turn started by window-a')
  let stopped = false
  const stopDeadline = Date.now() + 60_000
  while (Date.now() < stopDeadline) {
    const state = await a.call('session/state', { request: { sessionId: cancelId } })
    if (state?.running === false) { stopped = true; break }
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  check(stopped, 'the stopped Session returns to idle for both windows')
  const requestsAfterStop = mock.requests.length
  await new Promise(resolve => { setTimeout(resolve, 1_000) })
  check(mock.requests.length === requestsAfterStop, 'no new model request is made for the stopped turn')
  await cancelFollow.cancel()
  await b.close()
} catch (error) {
  process.stderr.write(`session queue smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.stderr.write(`mock request outcomes: ${JSON.stringify(mock.requests.map(({ behavior, outcome }) => ({ behavior, outcome })))}\n`)
  failures.push('exception')
} finally {
  try {
    if (started.pid !== undefined) process.kill(started.pid)
  } catch {
    // The idle exit already ended the process.
  }
  await mock.close()
  await mock.close()
  rmSync(storageDir, { recursive: true, force: true })
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS same-Session queue, steering, and cross-window stop\n')
  }
}
