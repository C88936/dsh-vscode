/**
 * C9 cross-window execution evidence with the local mock gateway: two windows share one host, B follows a Session
 * while A prompts, A's window closes mid-turn and B keeps receiving, two Sessions run in parallel, and a window that
 * reconnects after a disconnect reads the same stream without duplicates or gaps.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startMockLlmServer } from '../../../packages/test-support/llm-mock-server/src/index.ts'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-shared-turn-'))
const workspace = join(storageDir, 'workspace')
mkdirSync(workspace)
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const log = (line: string): void => { process.stderr.write(`${line}\n`) }
const failures: string[] = []
const startedHosts: { pid: number | undefined }[] = []
const openedFiles: string[] = []
const approvalPlugin = join(storageDir, 'approval-fixture.mjs')
const approvalOverlay = join(storageDir, 'approval-fixture.yml')
writeFileSync(approvalPlugin, `
export const name = 'c9-approval-fixture'
export const inject = ['approval']
export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (messages.length && JSON.stringify(messages).includes('C9 approval fixture message.')) {
      await ctx.approval.request({ agent, toolName: 'c9-fixture', signal })
    }
    return next()
  })
}
`)
writeFileSync(approvalOverlay, `- insert:\n    - id: c9-approval-fixture\n      name: '${pathToFileURL(approvalPlugin).href}'\n`)

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
  readonly error?: string
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
      configFingerprint: 'turn-smoke',
      limits: DEFAULT_BRIDGE_LIMITS,
      workspacePath: workspace,
      webview: { asUri: path => `uri:${path}`, postMessage: async (frame) => { frames.push(frame as Frame) } },
      openFile: async path => {
        openedFiles.push(`${id}:${path}`)
        return { ok: true }
      },
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
    const frame = await waitFor(this.frames, item => item.type === 'fetch-result' && item.id === id, `${this.id} ${method}`, 120_000)
    return JSON.parse(frame.body ?? '{}')?.result
  }

  /**
   * Open one long-lived stream (a Session follow) without waiting for it to end.
   * @param method - stream endpoint.
   * @param payload - request payload.
   * @returns the stream id, its live items, a cancel action, and the end frame when one arrived.
   */
  async openStream(method: string, payload: object): Promise<{
    readonly id: number
    readonly items: () => unknown[]
    cancel(): Promise<void>
    end(): Frame | undefined
  }> {
    const id = this.nextId++
    await this.bridge.handle({ type: 'stream-open', id, endpoint: method, payload: { args: payload } })
    return {
      id,
      items: () => this.frames.filter(frame => frame.type === 'stream-item' && frame.id === id).map(frame => frame.item),
      cancel: async () => { await this.bridge.handle({ type: 'stream-cancel', id }) },
      end: () => this.frames.find(frame => frame.type === 'stream-end' && frame.id === id),
    }
  }

  async close(): Promise<void> {
    await this.bridge.dispose()
  }
}

async function waitFor(frames: Frame[], predicate: (frame: Frame) => boolean, label: string, timeoutMs = 60_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Wait until a condition holds.
 * @param check - condition.
 * @param label - what is awaited.
 * @param timeoutMs - maximum wait.
 */
async function waitUntil(check: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (check()) return
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * @param items - collected stream items.
 * @returns their JSON text, for a substring check.
 */
function textOf(items: readonly unknown[]): string {
  return items.map(item => JSON.stringify(item)).join('\n')
}

const mock = await startMockLlmServer({
  port: 0,
  sequence: ['slow_success'],
  repeatLast: true,
  successText: `PONG ${'streaming-token '.repeat(40)}END-OF-STREAM`,
  chunkDelayMs: 80,
})

const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'shared-turn-smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  extraOverlays: [approvalOverlay],
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: workspace,
  workspacePath: workspace,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'turn-smoke',
  idleExitMs: 60_000,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  runtimePath: join(extensionPath, 'runtime'),
  env: { DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key', DSH_VSCODE_SHELL_BACKEND: 'local' },
  modelConfig: { provider: 'company', model: 'qwen-max', configured: true },
}
startedHosts.push(await startSharedHostProcess(hostOptions))

try {
  const a = await Window.attach('window-a')
  const b = await Window.attach('window-b')

  // Every window reads the same deployment model from the host that runs the application.
  const aConfig = await a.bridge.modelConfig()
  const bConfig = await b.bridge.modelConfig()
  check(aConfig.model === 'qwen-max' && aConfig.configured, 'window-a reads the host deployment model')
  check(bConfig.provider === aConfig.provider && bConfig.model === aConfig.model, 'window-b reads the same deployment model')

  const created = await a.call('session/create', { request: { cwd: workspace } })
  const sessionId = String(created?.sessionId ?? '')
  check(sessionId.length > 0, 'window-a creates a Session on the shared host')
  const selected = await a.call('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  check(selected?.selected?.model === 'deepseek-flash', 'window-a selects the mock model')
  const opened = await a.callRaw('commands/execute', { agentId: sessionId, line: '/open c9-smoke.txt', submittedAttachments: [] })
  if (opened?.ok !== true) log(`editor command rejected: ${JSON.stringify(opened)}`)
  check(opened?.value?.result?.kind === 'success' && openedFiles.join() === `window-a:${join(workspace, 'c9-smoke.txt')}`, 'editor request returns through the initiating window with the Session path')

  // B follows the Session before the prompt, so its items are live deliveries.
  const follow = await b.openStream('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, activate: true } })
  // Wait until the follow reports readiness (its opening item) so the prompt cannot race the subscription.
  await waitUntil(() => follow.items().length > 0, 'window-b follow readiness', 30_000)

  const prompted = await a.call('session/prompt', {
    request: {
      requestId: 'smoke-shared-1',
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly PONG.' }],
    },
  })
  check(prompted?.accepted === true, 'the prompt is accepted')

  // The turn is observable as running while B receives items incrementally.
  let runningWhileReceiving = false
  const observeDeadline = Date.now() + 60_000
  while (Date.now() < observeDeadline) {
    if (follow.items().length >= 2) {
      const state = await b.call('session/state', { request: { sessionId } })
      if (state?.running === true) { runningWhileReceiving = true; break }
      if (state?.running === false) break
    }
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  check(runningWhileReceiving, 'window-b receives items while the turn is still running')

  // Window A closes mid-turn; B must keep the same stream and see the rest of the output arrive.
  const itemsBeforeClose = follow.items().length
  await a.close()
  await waitUntil(() => textOf(follow.items()).includes('END-OF-STREAM'), 'the rest of the output reaches window-b', 60_000)
  check(follow.items().length > itemsBeforeClose, 'window-b keeps receiving after window-a closed')
  check(textOf(follow.items()).includes('END-OF-STREAM'), 'window-b sees the assistant output')
  await follow.cancel()

  const waited = await b.call('session/wait', { request: { sessionId, timeoutMs: 60_000 } })
  check(waited?.reason === 'idle', 'the turn reaches idle with no window left to ask')

  // Two Sessions run in parallel from the same window.
  const second = await b.call('session/create', { request: { cwd: workspace } })
  const secondId = String(second?.sessionId ?? '')
  await b.call('session/selectModel', { request: { sessionId: secondId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  const firstPrompt = b.call('session/prompt', {
    request: { requestId: 'smoke-shared-2', sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly PONG.' }] },
  })
  const secondPrompt = b.call('session/prompt', {
    request: { requestId: 'smoke-shared-3', sessionId: secondId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly PONG.' }] },
  })
  await Promise.all([firstPrompt, secondPrompt])
  let overlap = false
  const overlapDeadline = Date.now() + 60_000
  while (Date.now() < overlapDeadline) {
    const [one, two] = await Promise.all([
      b.call('session/state', { request: { sessionId } }),
      b.call('session/state', { request: { sessionId: secondId } }),
    ])
    if (one?.running === true && two?.running === true) { overlap = true; break }
    if (one?.running === false && two?.running === false) break
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  check(overlap, 'two Sessions run at the same time')
  const [firstDone, secondDone] = await Promise.all([
    b.call('session/wait', { request: { sessionId, timeoutMs: 120_000 } }),
    b.call('session/wait', { request: { sessionId: secondId, timeoutMs: 120_000 } }),
  ])
  check(firstDone?.reason === 'idle' && secondDone?.reason === 'idle', 'both parallel turns reach idle')

  // A mid-turn disconnect recovers on a new window: the turn stays in the host and the new window sees the rest.
  const third = await b.call('session/create', { request: { cwd: workspace } })
  const thirdId = String(third?.sessionId ?? '')
  await b.call('session/selectModel', { request: { sessionId: thirdId, provider: 'deepseek-official', model: 'deepseek-flash' } })
  const f = await Window.attach('window-f')
  const early = await f.openStream('session/follow', { request: { address: { kind: 'session', sessionId: thirdId }, assistantStream: true, activate: true } })
  await waitUntil(() => early.items().length > 0, 'window-f follow readiness', 30_000)
  await b.call('session/prompt', {
    request: { requestId: 'smoke-shared-4', sessionId: thirdId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly PONG.' }] },
  })
  await waitUntil(() => early.items().length >= 2, 'the third turn starts streaming', 60_000)
  await f.close()
  const d = await Window.attach('window-d')
  const resumed = await d.openStream('session/follow', { request: { address: { kind: 'session', sessionId: thirdId }, assistantStream: true } })
  await waitUntil(() => textOf(resumed.items()).includes('END-OF-STREAM'), 'the resumed window sees the rest of the turn', 60_000)
  check(resumed.items().length > 0, 'a window that reconnects mid-turn receives the remaining output')
  const resumedSeqs = resumed.items()
    .map(item => (item as { seq?: number }).seq)
    .filter((seq): seq is number => typeof seq === 'number')
  check(new Set(resumedSeqs).size === resumedSeqs.length, 'the mid-turn reconnect repeats no event')
  await resumed.cancel()
  await d.close()

  // A new window follows the completed Session and reads the same history once, without duplicates.
  await b.close()
  const c = await Window.attach('window-c')
  const replay = await c.openStream('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, activate: true } })
  await waitUntil(() => textOf(replay.items()).includes('END-OF-STREAM'), 'the reconnected window reads the finished turn', 60_000)
  check(textOf(replay.items()).includes('END-OF-STREAM'), 'a reconnected window reads the finished turn')
  const seqs = replay.items()
    .map(item => (item as { seq?: number }).seq)
    .filter((seq): seq is number => typeof seq === 'number')
  const unique = new Set(seqs)
  check(unique.size === seqs.length, 'the reconnected read has no duplicate sequence')
  await replay.cancel()
  const alternate = await c.openStream('session/follow', { request: { address: { kind: 'session', sessionId: secondId }, assistantStream: true, activate: true } })
  await waitUntil(() => textOf(alternate.items()).includes('END-OF-STREAM'), 'the alternate Session opens')
  await alternate.cancel()
  const restored = await c.openStream('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, activate: true } })
  await waitUntil(() => textOf(restored.items()).includes('END-OF-STREAM'), 'the original Session restores its transcript')
  const observer = await Window.attach('window-observer')
  const watching = await observer.openStream('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, activate: true } })
  await waitUntil(() => textOf(watching.items()).includes('END-OF-STREAM'), 'observer has replayed the existing transcript')
  const senderEvents = await c.openStream('$events', {})
  const observerEvents = await observer.openStream('$events', {})
  const eventOf = (items: readonly unknown[], type: string) => items.find(item =>
    item !== null && typeof item === 'object' && 'type' in item && item.type === type) as Record<string, unknown> | undefined
  await waitUntil(() => [senderEvents, observerEvents].every(stream => eventOf(stream.items(), 'ready') !== undefined), 'both approval event streams are ready')
  await c.call('session/prompt', {
    request: { requestId: 'smoke-shared-approval', sessionId, mode: 'queue', content: [{ type: 'text', text: 'C9 approval fixture message.' }] },
  })
  await waitUntil(() => [senderEvents, observerEvents].every(stream => eventOf(stream.items(), 'waterfall') !== undefined), 'both windows receive the pending approval', 15_000)
  const senderApproval = eventOf(senderEvents.items(), 'waterfall')
  const observerApproval = eventOf(observerEvents.items(), 'waterfall')
  check(senderApproval?.event === 'approval/request' && senderApproval.agentId === sessionId
    && senderApproval.eventId === observerApproval?.eventId, 'both windows receive the same Session approval')
  const clientId = eventOf(observerEvents.items(), 'ready')?.clientId
  const approvalResult = await observer.callRaw('$events/result', {
    clientId, eventId: observerApproval?.eventId, outcome: { kind: 'result', value: 'rejected' },
  })
  check(approvalResult?.ok === true, 'the observer resolves the approval')
  await waitUntil(() => eventOf(senderEvents.items(), 'cancel')?.eventId === senderApproval?.eventId, 'the sender sees the same approval dismissed', 15_000)
  const approvalDone = await c.call('session/wait', { request: { sessionId, timeoutMs: 30_000 } })
  const approvalStates = await Promise.all([c, observer].map(window => window.call('session/state', { request: { sessionId } })))
  check(approvalDone?.reason === 'idle' && approvalStates.every(state => Array.isArray(state?.pendingInput) && state.pendingInput.length === 0), 'approval clears in both windows')
  await senderEvents.cancel()
  await observerEvents.cancel()
  const beforeCancel = mock.requests.length
  await c.call('session/prompt', {
    request: { requestId: 'smoke-shared-cancel', sessionId, mode: 'queue', content: [{ type: 'text', text: 'C9 stop from the other window.' }] },
  })
  await waitUntil(() => mock.requests.length > beforeCancel, 'the turn to cancel has reached the model')
  const cancelled = await observer.call('session/cancel', { request: { sessionId } })
  check(cancelled?.accepted === true, 'a second window can stop the running Session')
  const [senderView, observerView] = await Promise.all([c, observer].map(window =>
    window.call('session/wait', { request: { sessionId, timeoutMs: 10_000 } })))
  check(senderView?.reason === 'idle' && observerView?.reason === 'idle', 'both windows observe idle after the stop')
  await restored.cancel()
  await watching.cancel()
  await observer.close()
  await c.close()
} catch (error) {
  process.stderr.write(`shared turn smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.stderr.write(`mock request outcomes: ${JSON.stringify(mock.requests.map(({ behavior, outcome }) => ({ behavior, outcome })))}\n`)
  failures.push('exception')
} finally {
  for (const host of startedHosts) {
    try {
      if (host.pid !== undefined) process.kill(host.pid)
    } catch {
      // The idle exit already ended the process.
    }
  }
  await mock.close()
  if (failures.length > 0) {
    try {
      const hostLog = existsSync(join(storageDir, 'runtime', 'host.log'))
        ? readFileSync(join(storageDir, 'runtime', 'host.log'), 'utf8').split('\n').slice(-30).join('\n')
        : '(no host log)'
      process.stdout.write(`host log tail:\n${hostLog}\n`)
    } catch {
      process.stdout.write('host log tail: unreadable\n')
    }
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS cross-window live output, editor routing, Session switching, approvals, stop and reconnect\n')
  }
  rmSync(storageDir, { recursive: true, force: true })
}


