/**
 * Companion host process.
 *
 * The VS Code extension host runs Electron's Node, which the DSH runtime
 * resolver's native module refuses. This process runs the same DSH application
 * under a supported Node release in one of two shapes:
 *
 * - one window's companion, serving the webview bridge over newline JSON on
 *   stdin/stdout;
 * - the shared host of one extension storage, listening on a local endpoint and
 *   giving every connected window its own bridge, peer, and resources while the
 *   application, Sessions, and plugins stay single.
 * @module @deepseek-ai/dsh-vscode/companion
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  bootDsh,
  loadFromAnchor,
  resolveInstallAnchor,
  resolveInstalledDshVersion,
  type DshApplication,
} from '../host/boot.ts'
import { WebviewBridge, type WebviewHost } from '../host/bridge.ts'
import { DEFAULT_BRIDGE_LIMITS, readBridgeLimits } from '../shared/limits.ts'
import type { HostModelConfig } from '../shared/host-protocol.ts'
import { hostActivity, withHostControl } from './activity.ts'
import { MaintenanceAdmission } from './admission.ts'
import { SharedHostServer } from './server.ts'
import { isWindowAnswer, WindowRequests, type WindowAnswer, type WindowRequest } from './window-requests.ts'
import { createSharedSessionFactory } from './session.ts'
import { MaintenanceGate, withMaintenanceGate } from './maintenance.ts'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'

/** One terminal command the extension runs on this process's behalf. */
interface TerminalOutcome {
  readonly ok: boolean
  readonly output?: string
  readonly exitCode?: number
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly truncated?: boolean
  readonly error?: string
}

/** Frames the extension sends to this process. */
type ParentFrame =
  | {
    type: 'fetch'
    id: number
    url: string
    body?: string
    method?: string
    headers?: Record<string, string>
    binary?: boolean
  }
  | { type: 'fetch-cancel'; id: number }
  | { type: 'upload-open'; id: number; url: string; method?: string; headers?: Record<string, string> }
  | { type: 'upload-chunk'; id: number; seq: number; data: string }
  | { type: 'upload-end'; id: number; seq: number }
  | { type: 'upload-cancel'; id: number }
  | { type: 'stream-open'; id: number; endpoint: string; payload: unknown; uplink?: boolean }
  | { type: 'stream-item-send'; id: number; seq: number; item: unknown }
  | { type: 'stream-end-send'; id: number; seq: number }
  | { type: 'stream-cancel'; id: number }
  | { type: 'asset'; id: number; url: string }
  | { type: 'log'; line: string }
  | { type: 'terminal-result'; id: number } & TerminalOutcome
  | { type: 'open-file-result'; id: number; ok: boolean; error?: string }
  | { type: 'activity-query'; id: number }
  | { type: 'shutdown' }

/** Message types this process accepts, paired with {@link isParentFrame}. */
const PARENT_FRAME_TYPES: ReadonlySet<string> = new Set([
  'fetch', 'fetch-cancel', 'upload-open', 'upload-chunk', 'upload-end', 'upload-cancel',
  'stream-open', 'stream-item-send', 'stream-end-send', 'stream-cancel', 'asset', 'log',
  'terminal-result', 'open-file-result', 'activity-query', 'shutdown',
])

/**
 * Validate one decoded stdin frame before it reaches the bridge. The extension
 * process is a wire peer, so a frame with an unknown type or no request id is
 * dropped with a diagnostic instead of reaching a handler that would treat a
 * missing field as "no value".
 * @param value - decoded JSON value.
 * @returns whether the frame is one this process handles.
 */
function isParentFrame(value: unknown): value is ParentFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown }
  if (typeof frame.type !== 'string' || !PARENT_FRAME_TYPES.has(frame.type)) return false
  return frame.type === 'shutdown' || Number.isInteger(frame.id)
}

/** Whether this process serves several windows over a local endpoint. */
let serveMode = false

/**
 * Where a window request goes when this process is the shared host.
 *
 * In the two shapes the direction differs: a per-window companion writes child
 * frames to its parent on stdout, while the shared host must pick one of its
 * connections and read the answer back over that connection.
 */
let windowPort: WindowRequests | undefined

/**
 * @param value - candidate frame.
 * @returns whether it is one the extension answers, not the webview protocol.
 */
function isWindowRequest(value: unknown): value is WindowRequest {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown }
  return (frame.type === 'open-file' || frame.type === 'terminal-run' || frame.type === 'terminal-cancel')
    && Number.isInteger(frame.id)
}

/**
 * Settle a window request no connection can take, so the tool reports a clear
 * failure instead of waiting for an answer that cannot arrive.
 * @param frame - the unhandled request.
 */
function failWindowRequest(frame: WindowRequest): void {
  const reason = 'no VS Code window is connected to this DSH host'
  if (frame.type === 'open-file') {
    const pending = openRequests.get(frame.id)
    openRequests.delete(frame.id)
    pending?.({ ok: false, error: reason })
    return
  }
  if (frame.type === 'terminal-run') {
    const pending = terminalRequests.get(frame.id)
    terminalRequests.delete(frame.id)
    pending?.({ ok: false, error: reason })
  }
}

/**
 * Hand one window answer to the request that is waiting for it.
 * @param frame - decoded answer frame.
 */
function settleWindowAnswer(frame: WindowAnswer): void {
  if (frame.type === 'open-file-result') {
    const pending = openRequests.get(frame.id)
    openRequests.delete(frame.id)
    pending?.({ ok: frame.ok === true, ...frame.error === undefined ? {} : { error: frame.error } })
    return
  }
  const pending = terminalRequests.get(frame.id)
  terminalRequests.delete(frame.id)
  pending?.(frame)
}

/**
 * @param frame - JSON-serializable frame.
 */
function write(frame: unknown): void {  // A shared host has no parent reading stdout; its diagnostics belong on
  // stderr so they do not sit in an unread pipe.
  if (serveMode && isLogFrame(frame)) {
    process.stderr.write(`${frame.line}\n`)
    return
  }
  // Editor and terminal requests belong to a window, not to a parent pipe. The
  // shared host routes each one to a connection and reads its answer back.
  if (serveMode && isWindowRequest(frame)) {
    if (windowPort?.send(frame) !== true) failWindowRequest(frame)
    return
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/**
 * @param value - candidate frame.
 * @returns whether it is a log frame with text.
 */
function isLogFrame(value: unknown): value is { readonly type: 'log'; readonly line: string } {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; line?: unknown }
  return frame.type === 'log' && typeof frame.line === 'string'
}

/**
 * @param line - diagnostic text.
 */
function log(line: string): void {
  write({ type: 'log', line })
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Name the sessions whose Agents are running a turn, for a refusal report.
 * @param get - service lookup on the live application context.
 * @returns distinct running session ids, sorted; empty when none is running.
 */
function runningSessionIds(get: (name: string) => unknown): string[] {
  const agents = get('agents') as {
    list(): readonly { readonly status: string; readonly session?: { readonly id: unknown } }[]
  } | undefined
  const ids = new Set<string>()
  for (const agent of agents?.list() ?? []) {
    if (agent.status !== 'running') continue
    ids.add(String(agent.session?.id ?? 'unknown'))
  }
  return [...ids].sort()
}

/** Filesystem paths the extension supplied for this host. */
interface CompanionOptions {
  readonly extensionPath: string
  readonly storageDir: string
  /** Launch directory this activation owns: generated overlays and webview bundles. */
  readonly launchDir: string
  readonly overlayPath: string
  readonly shellRoot: string
  readonly cwd: string
  readonly workspacePath?: string
  readonly runtimePath?: string
  readonly extraOverlays?: readonly string[]
  /** Bounded-transfer budgets the extension read from its settings. */
  readonly limits?: unknown
  /** Deployment model configuration this host boots with, reported to every window. */
  readonly modelConfig?: HostModelConfig
  /** Present when this process is the shared host instead of one window's stdio companion. */
  readonly serve?: SharedHostServeOptions
}

/** Endpoint and policy for one shared-host process. */
interface SharedHostServeOptions {
  /** Named pipe or socket path the host listens on. */
  readonly endpoint: string
  /** Credential every window presents in its hello. */
  readonly token: string
  /** Root directory holding each window connection's resources. */
  readonly connectionsDir: string
  /** Deployment settings fingerprint every window is told about. */
  readonly configFingerprint: string
  /** Grace period after the last window leaves, in milliseconds. */
  readonly idleExitMs?: number
}

/**
 * Read the companion options from the process arguments.
 * @returns the parsed options.
 * @throws when an argument is missing.
 */
function readOptions(): CompanionOptions {
  const raw = process.argv[2]
  if (raw === undefined) throw new Error('dsh companion: options argument is missing')
  return JSON.parse(raw) as CompanionOptions
}

/** Absolute paths the extension maps to webview URIs. */
const host: WebviewHost = {
  asUri: path => path,
  postMessage: async (message) => { write(message) },
}

/** Pending editor open requests, keyed by request id. */
const openRequests = new Map<number, (outcome: { ok: boolean; error?: string }) => void>()
let openSeq = 0

/**
 * Ask the extension to show one file in the VS Code editor.
 * @param path - file the command named.
 * @returns the extension's answer.
 */
async function requestOpenFile(path: string): Promise<{ ok: boolean; error?: string }> {
  const id = ++openSeq
  const answer = new Promise<{ ok: boolean; error?: string }>((resolve) => { openRequests.set(id, resolve) })
  write({ type: 'open-file', id, path })
  return await answer
}

/**
 * Install the globals the editor provider reads before the Loader mounts it.
 */
function installEditorBridge(): void {
  ;(globalThis as { __DSH_VSCODE_OPEN_FILE__?: unknown }).__DSH_VSCODE_OPEN_FILE__ = requestOpenFile
}


const terminalRequests = new Map<number, (outcome: TerminalOutcome) => void>()
let terminalSeq = 0

/**
 * Ask the extension to run one command in its integrated terminal.
 * @param command - command line.
 * @param cwd - working directory.
 * @returns the terminal outcome.
 */
async function requestTerminal(request: {
  command: string
  cwd: string
  timeoutMs: number
  onExpiry: 'kill' | 'none'
  stdoutMaxBytes: number
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<{
  output: string
  exitCode: number | undefined
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}> {
  request.signal?.throwIfAborted()
  const id = ++terminalSeq
  const answer = new Promise<TerminalOutcome>((resolve) => { terminalRequests.set(id, resolve) })
  write({
    type: 'terminal-run',
    id,
    command: request.command,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    onExpiry: request.onExpiry,
    stdoutMaxBytes: request.stdoutMaxBytes,
    ...request.env === undefined ? {} : { env: request.env },
  })
  const cancel = (): void => { write({ type: 'terminal-cancel', id }) }
  request.signal?.addEventListener('abort', cancel, { once: true })
  const outcome = await answer
  request.signal?.removeEventListener('abort', cancel)
  if (!outcome.ok) throw new Error(outcome.error ?? 'the VS Code terminal failed')
  return {
    output: outcome.output ?? '',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut === true,
    aborted: outcome.aborted === true,
    truncated: outcome.truncated === true,
  }
}

/**
 * Generate the editor and optional integrated terminal registrations.
 * @param options - companion options.
 */
async function installShellProvider(options: CompanionOptions): Promise<string> {
  const patchPath = join(options.launchDir, 'vscode-window.patch.yml')
  mkdirSync(options.launchDir, { recursive: true })
  const editorRows = [
    '    - id: vscode-editor',
    `      name: '${pathToFileURL(join(options.extensionPath, 'lib', 'editor-provider.cjs')).href}'`,
    '',
  ]
  if ((process.env.DSH_VSCODE_SHELL_BACKEND ?? 'vscode') !== 'vscode') {
    writeFileSync(patchPath, ['- insert:', ...editorRows].join('\n'))
    return patchPath
  }
  const anchor = resolveInstallAnchor(options.extensionPath, options.runtimePath)
  const shell = await loadFromAnchor<{ ShellExecutor: unknown }>(anchor, '@deepseek-ai/dsh-shell')
  const globals = globalThis as {
    __DSH_VSCODE_SHELL_BASE__?: unknown
    __DSH_VSCODE_TERMINAL__?: unknown
  }
  globals.__DSH_VSCODE_SHELL_BASE__ = shell.ShellExecutor
  globals.__DSH_VSCODE_TERMINAL__ = { run: requestTerminal }
  const providerPath = join(options.extensionPath, 'lib', 'terminal-provider.cjs')
  writeFileSync(patchPath, [
    '# Generated by the DSH extension: run shell commands in the VS Code terminal.',
    '- id: bash-sandbox',
    '  disabled: true',
    '- id: pwsh-sandbox',
    '  disabled: true',
    // The integrated terminal is the user's own shell: it does not confine, so
    // permission presets (which bundle a sandbox mode) cannot compose over it.
    '- id: permission',
    '  disabled: true',
    '- insert:',
    '    - id: vscode-shell',
    `      name: '${pathToFileURL(providerPath).href}'`,
    ...editorRows,
  ].join('\n'))
  return patchPath
}

/**
 * @param options - companion options.
 * @returns the DSH release the configured installation carries, or `unknown`.
 */
function installedDshVersion(options: CompanionOptions): string {
  try {
    return resolveInstalledDshVersion(resolveInstallAnchor(options.extensionPath, options.runtimePath)) ?? 'unknown'
  } catch (error) {
    // Diagnostics only: a release this host cannot name must not prevent it
    // from serving windows.
    log(`dsh host: the DSH release could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return 'unknown'
  }
}

/**
 * Run this process as the shared host of one extension storage.
 *
 * The application boots once. Every VS Code window connects over the local
 * endpoint and receives its own bridge, peer, and resource directory while
 * sharing Sessions, execution state, and plugins. After the last window leaves,
 * the host waits a grace period and exits only when no turn, terminal, or
 * package operation is still running.
 * @param options - companion options.
 * @param serve - endpoint, credential, and idle policy.
 * @returns settles after the endpoint is listening; the process stays alive on
 * the listener and the application tree.
 */
async function runSharedHost(options: CompanionOptions, serve: SharedHostServeOptions): Promise<void> {
  // A shared host still runs the tools of every window, so the VS Code terminal
  // and editor integrations are installed before the application boots; their
  // requests are routed to a connection of whichever window can serve them.
  installEditorBridge()
  const shellPatch = await installShellProvider(options)
  const app: DshApplication = await bootDsh({
    extensionPath: options.extensionPath,
    storageDir: options.storageDir,
    overlayPath: options.overlayPath,
    extraOverlays: [shellPatch, ...options.extraOverlays ?? []],
    cwd: options.cwd,
    ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
    ...options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath },
    log,
  })
  const windows = new WindowRequests(settleWindowAnswer)
  windowPort = windows
  const packageOperations = new Set<string>()
  app.ctx.on('plugin-manager/operation', (operation) => {
    if (operation.phase === 'started') packageOperations.add(String(operation.id))
    else packageOperations.delete(String(operation.id))
  })
  const limits = readBridgeLimits(options.limits) ?? DEFAULT_BRIDGE_LIMITS
  // One gate for the whole host: a module operation admitted by one window
  // closes turn admission for every window until its result settles.
  const maintenance = new MaintenanceGate({
    activity: () => hostActivity(name => app.ctx.get(name), packageOperations),
    // Refusals name the running turns' Sessions so a window knows what holds
    // the host, matching the maintenance restart's report.
    runningSessions: () => runningSessionIds(name => app.ctx.get(name)),
    log,
  })
  // A turn can also start inside the host, where the Webview gate cannot see
  // it; the pre-step listener rejects those model steps while maintenance runs.
  await app.ctx.plugin(MaintenanceAdmission, { admission: maintenance })
  let idleTimer: NodeJS.Timeout | undefined
  let stopping = false
  const shutdown = async (host: SharedHostServer, reason: string): Promise<void> => {
    if (stopping) return
    stopping = true
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    log(`dsh host: shutting down: ${reason}`)
    try {
      await host.close()
    } catch (error) {
      log(`dsh host: closing window connections failed: ${describe(error)}`)
    }
    try {
      await app.ctx.fiber.dispose()
    } catch (error) {
      log(`dsh host: disposal failed: ${describe(error)}`)
    }
    // A held maintenance gate belongs to this process; releasing it keeps a
    // failed stop from leaving a host that refuses every turn forever.
    maintenanceHold?.()
    maintenanceHold = undefined
    // The host owns the files it booted from; nothing reads them after disposal.
    try {
      rmSync(options.launchDir, { recursive: true, force: true })
      log(`dsh host: removed launch files ${options.launchDir}`)
    } catch (error) {
      log(`dsh host: could not remove launch files ${options.launchDir}: ${describe(error)}`)
    }
    process.exit(0)
  }
  const scheduleIdleExit = (host: SharedHostServer): void => {
    if (stopping) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (host.connectionCount !== 0) return
      const activity = hostActivity(name => app.ctx.get(name), packageOperations)
      if (maintenance.inMaintenance || activity.runningTurns > 0 || activity.runningTerminals > 0 || activity.packageOperations > 0) {
        // Work a window started is still running; keep the host until it settles.
        scheduleIdleExit(host)
        return
      }
      void shutdown(host, 'no VS Code window is connected and no work is running')
    }, serve.idleExitMs ?? 60_000)
  }
  // Admission is closed for new turns from the instant a maintenance stop
  // begins; the gate is held until the host exits so a turn cannot slip in
  // between the activity check and the stop.
  let maintenanceHold: (() => void) | undefined
  const requestShutdown = async (): Promise<{ readonly ok: boolean; readonly error?: string }> => {
    if (stopping) return { ok: false, error: 'DSH is already stopping; the shared host was not stopped again.' }
    if (maintenance.inMaintenance) {
      return { ok: false, error: 'DSH is applying a plugin change; wait for it to finish before requesting a maintenance restart.' }
    }
    const release = await maintenance.acquire()
    windows.broadcastMaintenance({ type: 'host-maintenance', active: true, reason: 'a window requested a maintenance restart' })
    const activity = hostActivity(name => app.ctx.get(name), packageOperations)
    const sessions = runningSessionIds(name => app.ctx.get(name))
    const parts: string[] = []
    if (activity.runningTurns > 0) {
      parts.push(`${String(activity.runningTurns)} running ${activity.runningTurns === 1 ? 'turn' : 'turns'}`)
    }
    if (activity.packageOperations > 0) {
      parts.push(`${String(activity.packageOperations)} running package ${activity.packageOperations === 1 ? 'operation' : 'operations'}`)
    }
    if (activity.runningTerminals > 0) {
      parts.push(`${String(activity.runningTerminals)} running terminal ${activity.runningTerminals === 1 ? 'command' : 'commands'}`)
    }
    if (parts.length > 0) {
      release()
      windows.broadcastMaintenance({ type: 'host-maintenance', active: false, reason: 'the maintenance restart was refused while work is running' })
      const occupied = sessions.length === 0 ? '' : ` Running sessions: ${sessions.slice(0, 5).join(', ')}${sessions.length > 5 ? '…' : ''}.`
      return { ok: false, error: `DSH still reports ${parts.join(', ')}; the shared host was not stopped.${occupied}` }
    }
    // Keep the gate: admission stays closed until this host exits.
    maintenanceHold = release
    // The answer must reach the requesting window before the connection it came
    // over is closed, so the stop is scheduled rather than run inline.
    setTimeout(() => { void shutdown(listener, 'a window requested a maintenance restart') }, 50)
    return { ok: true }
  }
  const createSession = createSharedSessionFactory({
    ctx: app.ctx,
    shellRoot: options.shellRoot,
    connectionsDir: serve.connectionsDir,
    limits,
    log,
  })
  const listener = new SharedHostServer({
    endpoint: serve.endpoint,
    token: serve.token,
    instanceId: randomUUID(),
    dshVersion: installedDshVersion(options),
    configFingerprint: serve.configFingerprint,
    log,
    ...process.platform === 'win32' ? {} : { staleSocketPath: serve.endpoint },
    createSession: async (hello, connection) => {
      const session = await createSession(hello, connection)
      // Control frames answer from the host; the maintenance rules decide
      // whether a frame may start work or replace module code first.
      return windows.bind(connection, withHostControl(withMaintenanceGate(session, connection, maintenance), connection, {
        activity: () => hostActivity(name => app.ctx.get(name), packageOperations),
        config: () => options.modelConfig ?? { provider: '', model: '', configured: false },
        shutdown: requestShutdown,
      }))
    },
    onIdle: () => { scheduleIdleExit(listener) },
  })
  await listener.listen()
  log(`dsh host: serving ${serve.endpoint}`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void shutdown(listener, `received ${signal}`) })
  }
}

async function main(): Promise<void> {
  const options = readOptions()
  if (options.serve !== undefined) {
    serveMode = true
    log(`dsh host: node ${process.version}`)
    await runSharedHost(options, options.serve)
    return
  }
  log(`dsh companion: node ${process.version}`)
  installEditorBridge()
  const shellPatch = await installShellProvider(options)
  const app: DshApplication = await bootDsh({
    extensionPath: options.extensionPath,
    storageDir: options.storageDir,
    overlayPath: options.overlayPath,
    extraOverlays: [shellPatch, ...options.extraOverlays ?? []],
    cwd: options.cwd,
    ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
    ...options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath },
    log,
  })
  const bridge = new WebviewBridge(
    app.ctx,
    options.launchDir,
    host,
    log,
    readBridgeLimits(options.limits) ?? DEFAULT_BRIDGE_LIMITS,
  )
  const payload = await bridge.prepare(options.shellRoot)
  write({ type: 'ready', payload })

  const lines = createInterface({ input: process.stdin })
  let stopping = false
  // The extension's restart check cannot see this process's work, so it asks here. The manager's own
  // announcements name operations that started and have not settled.
  const packageOperations = new Set<string>()
  app.ctx.on('plugin-manager/operation', (operation) => {
    if (operation.phase === 'started') packageOperations.add(String(operation.id))
    else packageOperations.delete(String(operation.id))
  })
  lines.on('line', (line) => {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch (error) {
      log(`dsh companion: unreadable frame ${String(error)}`)
      return
    }
    if (!isParentFrame(decoded)) {
      log(`dsh companion: unrecognized frame ${line.slice(0, 200)}`)
      return
    }
    const frame = decoded
    if (frame.type === 'activity-query') {
      write({
        type: 'activity-result',
        id: frame.id,
        activity: hostActivity(name => app.ctx.get(name), packageOperations),
      })
      return
    }
    if (isWindowAnswer(frame)) {
      settleWindowAnswer(frame)
      return
    }
    if (frame.type === 'shutdown') {
      stopping = true
      lines.close()
      bridge.dispose()
      void app.ctx.fiber.dispose().finally(() => { process.exit(0) })
      return
    }
    void bridge.handle(frame).catch((error: unknown) => {
      log(`dsh companion: frame failed ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  lines.on('close', () => {
    if (stopping) return
    bridge.dispose()
    void app.ctx.fiber.dispose().finally(() => { process.exit(0) })
  })

  // The stdin loop must exist before this runs: its editor request is answered
  // on the same channel.
  if (process.env.DSH_VSCODE_EDITOR_SMOKE === '1') {
    void (async () => {
      try {
        const outcome = await requestOpenFile(join(options.extensionPath, 'README.md'))
        log(outcome.ok ? 'dsh: editor smoke opened README.md' : `dsh: editor smoke failed: ${String(outcome.error)}`)
      } catch (error) {
        log(`dsh: editor smoke failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  // The stdin loop must exist before this runs: its terminal request is
  // answered on the same channel.
  if (process.env.DSH_VSCODE_SHELL_SMOKE === '1') {
    void (async () => {
      const shell = app.ctx.get('shell') as {
        execute(request: {
          command: string
          workdir?: string
          timeoutMs?: number
          onExpiry?: 'kill' | 'none'
          sandboxPolicy?: { mode: string; workspaceRoot: string }
        }): Promise<{ result(): Promise<{ exitCode: number | null; stdout: { text: string } }> }>
      } | undefined
      if (shell === undefined) {
        log('dsh: shell smoke: ctx.shell is unavailable')
        return
      }
      try {
        const execution = await shell.execute({
          command: 'echo provider-ok',
          workdir: options.cwd,
          // The tool path resolves this from the session's permission preset; the smoke names one directly.
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: options.cwd },
        })
        const result = await execution.result()
        log(`dsh: shell smoke exit=${String(result.exitCode)} output=${result.stdout.text.trim()}`)
      } catch (error) {
        log(`dsh: shell smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
    })()
  }

  if (process.env.DSH_VSCODE_SANDBOX_SMOKE === '1') {
    void (async () => {
      const sandbox = app.ctx.get('sandbox') as {
        confine(
          argv: readonly string[],
          policy: { mode: 'workspace-write'; workspaceRoot: string },
          signal?: AbortSignal,
        ): Promise<unknown>
      } | undefined
      const shell = app.ctx.get('shell') as {
        execute(request: {
          command: string
          workdir?: string
          timeoutMs?: number
          onExpiry?: 'kill' | 'none'
          sandboxPolicy?: { mode: string; workspaceRoot: string }
        }): Promise<{ result(): Promise<{ exitCode: number | null; stdout: { text: string } }> }>
      } | undefined
      if (shell === undefined) {
        log('dsh: sandbox smoke: ctx.shell is unavailable')
        return
      }
      log(`dsh: sandbox smoke shell executor: ${
        (shell as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
      }`)
      try {
        if (sandbox !== undefined) {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort(new Error('sandbox confine timeout')) }, 10_000)
          log('dsh: sandbox smoke invoking confine')
          try {
            await sandbox.confine(
              [process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? '/c' : '-c', 'echo sandbox-ok'],
              { mode: 'workspace-write', workspaceRoot: options.cwd },
              controller.signal,
            )
            log('dsh: sandbox smoke confine completed')
          } finally {
            clearTimeout(timer)
          }
        }
        const command = 'echo sandbox-ok'
        log('dsh: sandbox smoke invoking shell')
        const execution = await shell.execute({
          command,
          workdir: options.cwd,
          timeoutMs: 15_000,
          onExpiry: 'kill',
          sandboxPolicy: { mode: 'workspace-write', workspaceRoot: options.cwd },
        })
        log('dsh: sandbox smoke execution prepared')
        const result = await execution.result()
        log(`dsh: sandbox smoke exit=${String(result.exitCode)} output=${result.stdout.text.trim()}`)
      } catch (error) {
        log(`dsh: sandbox smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
    })()
  }
}

void (async () => { await main() })().catch((error: unknown) => {
  write({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
