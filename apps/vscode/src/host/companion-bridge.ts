/**
 * Extension side of the companion host.
 *
 * It spawns the DSH application under a supported Node release, forwards the
 * webview's frames to it, and maps the host's absolute asset paths to webview
 * URIs. Nothing is served over a socket.
 * @module @deepseek-ai/dsh-vscode/host/companion-bridge
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { WebviewBootPayload, WebviewHost } from './bridge.ts'
import type { TerminalRunOptions, TerminalRunResult } from './terminal.ts'
import { DEFAULT_BRIDGE_LIMITS, readBridgeLimits, type BridgeLimits } from '../shared/limits.ts'

/** Minimum Node release the DSH runtime resolver supports. */
const MINIMUM_NODE_MAJOR = 24
const MINIMUM_NODE_MINOR = 9

/** Frames the companion sends back. */
export type ChildFrame =
  | { type: 'ready'; payload: RawPayload }
  | { type: 'fetch-result'; id: number; status: number; body: string }
  | { type: 'fetch-result'; id: number; status: number; base64: string; contentType: string }
  | { type: 'stream-item'; id: number; item: unknown }
  | { type: 'stream-end'; id: number; error?: { code: string; message: string } }
  | { type: 'stream-uplink-ack'; id: number; seq: number }
  | { type: 'upload-ack'; id: number; seq: number }
  | { type: 'upload-result'; id: number; status: number; body: string }
  | {
    type: 'asset-result'
    id: number
    uri?: string
    /** Asset references the companion prepared beside the requested bundle, as local paths. */
    assets?: Record<string, string>
    error?: string
  }
  | {
    type: 'terminal-run'
    id: number
    command: string
    cwd: string
    timeoutMs: number
    onExpiry: 'kill' | 'none'
    stdoutMaxBytes: number
    env?: Record<string, string>
  }
  | { type: 'terminal-cancel'; id: number }
  | { type: 'open-file'; id: number; path: string }
  | { type: 'activity-result'; id: number; activity: CompanionActivity }
  | { type: 'log'; line: string }
  | { type: 'fatal'; message: string }

/** Running work one companion reports for the extension's restart check. */
export interface CompanionActivity {
  /** Live Agents running a turn. */
  readonly runningTurns: number
  /** Package-manager operations announced as started and not settled. */
  readonly packageOperations: number
  /** Running DSH terminal commands inside the companion process. */
  readonly runningTerminals: number
}

/** Boot payload with filesystem paths; the extension maps them to webview URIs. */
export interface RawPayload {
  readonly injections: readonly unknown[]
  readonly assets: Readonly<Record<string, string>>
  readonly shell: string
  readonly styles: readonly string[]
  readonly limits: BridgeLimits
}

/**
 * Whether one decoded child frame carries the fields its type declares.
 *
 * The companion is a separate process, so its stdout is a wire boundary: a
 * malformed version of a known frame is dropped with a diagnostic instead of
 * being forwarded to the Webview with missing fields, where a request would
 * wait for an answer that can no longer be recognized.
 * @param frame - the parsed frame.
 * @returns whether the frame is a complete known message.
 */
export function isChildFrame(frame: ChildFrame): boolean {
  switch (frame.type) {
    case 'ready':
      return isRecord(frame.payload)
        && Array.isArray(frame.payload.injections)
        && isRecord(frame.payload.assets)
        && typeof frame.payload.shell === 'string'
        && Array.isArray(frame.payload.styles)
        // The page enforces these budgets, so a payload without a complete
        // record would silently fall back to defaults the deployment did not choose.
        && readBridgeLimits(frame.payload.limits) !== undefined
    case 'fetch-result':
      return Number.isInteger(frame.id) && Number.isInteger(frame.status)
        && ('base64' in frame
          ? typeof frame.base64 === 'string' && typeof frame.contentType === 'string'
          : typeof frame.body === 'string')
    case 'stream-item':
      return Number.isInteger(frame.id)
    case 'stream-end':
      return Number.isInteger(frame.id) && (frame.error === undefined || isFailure(frame.error))
    case 'stream-uplink-ack':
    case 'upload-ack':
      return Number.isInteger(frame.id) && Number.isInteger(frame.seq)
    case 'upload-result':
      return Number.isInteger(frame.id) && Number.isInteger(frame.status) && typeof frame.body === 'string'
    case 'asset-result':
      return Number.isInteger(frame.id)
        && (frame.uri === undefined || typeof frame.uri === 'string')
        && (frame.error === undefined || typeof frame.error === 'string')
        && (frame.assets === undefined
          || isRecord(frame.assets) && Object.values(frame.assets).every(value => typeof value === 'string'))
    case 'terminal-run':
      return Number.isInteger(frame.id)
        && typeof frame.command === 'string'
        && typeof frame.cwd === 'string'
        && Number.isInteger(frame.timeoutMs)
        && (frame.onExpiry === 'kill' || frame.onExpiry === 'none')
        && Number.isInteger(frame.stdoutMaxBytes)
        && (frame.env === undefined
          || isRecord(frame.env) && Object.values(frame.env).every(value => typeof value === 'string'))
    case 'terminal-cancel':
      return Number.isInteger(frame.id)
    case 'open-file':
      return Number.isInteger(frame.id) && typeof frame.path === 'string'
    case 'activity-result':
      return Number.isInteger(frame.id) && isActivity(frame.activity)
    case 'log':
      return typeof frame.line === 'string'
    case 'fatal':
      return typeof frame.message === 'string'
  }
}

/**
 * @param value - decoded JSON value.
 * @returns whether it is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * @param value - decoded activity record.
 * @returns whether every count is a non-negative integer.
 */
function isActivity(value: unknown): value is CompanionActivity {
  if (!isRecord(value)) return false
  for (const count of [value.runningTurns, value.packageOperations, value.runningTerminals]) {
    if (!Number.isInteger(count) || (count as number) < 0) return false
  }
  return true
}

/**
 * @param error - reported stream failure.
 * @returns whether it carries both fields the Webview reads.
 */
function isFailure(error: { code: string; message: string }): boolean {
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/** Inputs for one companion start. */
export interface CompanionOptions {
  /** Extension root, passed through to the host's profile resolution. */
  readonly extensionPath: string
  /** Extension storage directory; the profile and Harness home live below it. */
  readonly storageDir: string
  /** This activation's launch directory for generated overlays and webview bundles. */
  readonly launchDir: string
  /** Shipped overlay patch path. */
  readonly overlayPath: string
  /** Built Web frontend directory. */
  readonly shellRoot: string
  /** Working directory for the application (the VS Code workspace folder). */
  readonly cwd: string
  /** Existing VS Code folder DSH should register as its initial Workspace. */
  readonly workspacePath?: string
  /** Additional overlay patches applied above the shipped one. */
  readonly extraOverlays?: readonly string[]
  /** Extra environment for the application (credentials and endpoint). */
  readonly env?: Record<string, string>
  /** Bounded-transfer budgets; defaults apply when the extension names none. */
  readonly limits?: BridgeLimits
  /** Configured DSH installation. */
  readonly runtimePath?: string
  /** Configured Node executable for the companion host. */
  readonly nodePath?: string
  /** Runs a command in the VS Code integrated terminal. */
  readonly runInTerminal?: (command: string, cwd: string, options: TerminalRunOptions) => Promise<TerminalRunResult>
  /** Shows one file in the VS Code editor. */
  readonly openFile?: (path: string) => Promise<{ ok: boolean; error?: string }>
  /** Reports an unexpected companion exit after startup. */
  readonly onExit?: (exit: CompanionExit) => void
  /** Diagnostic sink. */
  readonly log: (line: string) => void
}

/** One companion-process exit observed by the extension. */
export interface CompanionExit {
  /** Process exit code, when the operating system reported one. */
  readonly code: number | null
  /** Terminating signal, when the operating system reported one. */
  readonly signal: NodeJS.Signals | null
}

/**
 * Resolve the Node executable that runs the companion.
 * @param log - diagnostic sink.
 * @returns the executable path or name.
 * @throws when no Node release satisfies the DSH runtime requirement.
 */
export function resolveNodeExecutable(log: (line: string) => void, preferred?: string): string {
  const configured = preferred ?? process.env.DSH_VSCODE_NODE
  const candidates = configured === undefined ? ['node'] : [configured, 'node']
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim()
      const parts = version.replace(/^v/u, '').split('.')
      const major = Number.parseInt(parts[0] ?? '0', 10)
      const minor = Number.parseInt(parts[1] ?? '0', 10)
      if (major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR)) return candidate
      failures.push(`${candidate} is ${version}`)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`dsh: no supported Node executable (${failures.join('; ')})`)
  throw new Error(
    `dsh: the VS Code extension host runs Electron's Node, and DSH needs Node >= `
    + `${String(MINIMUM_NODE_MAJOR)}.${String(MINIMUM_NODE_MINOR)}. Install Node 24 and restart, or set DSH_VSCODE_NODE.`,
  )
}

/** One running companion process. */
export class CompanionBridge {
  private child: ChildProcess | undefined
  private payload: WebviewBootPayload | undefined
  private ready: Promise<WebviewBootPayload> | undefined
  private stopping = false
  private exited: Promise<void> = Promise.resolve()
  private settleExit: (() => void) | undefined
  private webview: WebviewHost | undefined
  private log: (line: string) => void = () => {}
  /** Pending activity queries, keyed by request id. */
  private readonly activities = new Map<number, {
    resolve(activity: CompanionActivity): void
    reject(error: Error): void
  }>()
  private activitySeq = 0

  private constructor() {}

  /**
   * Spawn the companion and complete its handshake.
   * @param options - extension paths and diagnostic sink.
   * @param webview - the webview whose URIs the payload uses.
   * @returns the running bridge.
   */
  static async start(options: CompanionOptions, webview: WebviewHost): Promise<CompanionBridge> {
    const bridge = new CompanionBridge()
    bridge.log = options.log
    bridge.webview = webview
    const executable = resolveNodeExecutable(options.log, options.nodePath)
    const script = join(options.extensionPath, 'lib', 'companion.cjs')
    options.log(`dsh: starting companion host with ${executable}`)
    const child = spawn(executable, [script, JSON.stringify({
      extensionPath: options.extensionPath,
      storageDir: options.storageDir,
      launchDir: options.launchDir,
      overlayPath: options.overlayPath,
      shellRoot: options.shellRoot,
      cwd: options.cwd,
      limits: options.limits ?? DEFAULT_BRIDGE_LIMITS,
      ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
      ...options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath },
      ...options.extraOverlays === undefined ? {} : { extraOverlays: options.extraOverlays },
    })], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: options.cwd,
      // The companion owns the same isolated Harness home the in-process path
      // would use, whatever the extension host environment carries.
      env: { ...process.env, ...options.env, DSH_HOME: join(options.storageDir, 'home') },
    })
    bridge.child = child
    const terminals = new Map<number, AbortController>()
    const exit = Promise.withResolvers<void>()
    bridge.exited = exit.promise
    bridge.settleExit = exit.resolve
    const handshake = Promise.withResolvers<WebviewBootPayload>()
    const lines = createInterface({ input: child.stdout ?? undefined })
    const forward = (message: unknown): void => {
      void Promise.resolve(webview.postMessage(message)).catch((error: unknown) => {
        options.log(`dsh: a companion frame could not reach the Webview: ${messageOf(error)}`)
      })
    }
    lines.on('line', (line) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(line)
      } catch (error) {
        options.log(`dsh: unreadable companion frame ${String(error)}`)
        return
      }
      if (typeof decoded !== 'object' || decoded === null) {
        options.log(`dsh: companion frame is not an object: ${line.slice(0, 200)}`)
        return
      }
      const frame = decoded as ChildFrame
      if (!isChildFrame(frame)) {
        options.log(`dsh: companion frame is not a known message: ${line.slice(0, 200)}`)
        return
      }
      // A stopping bridge must not forward late answers: the Webview they
      // belong to is being replaced, and its request ids may be reused.
      if (bridge.stopping) return
      switch (frame.type) {
        case 'ready':
          bridge.payload = mapPayload(frame.payload, webview)
          handshake.resolve(bridge.payload)
          return
        case 'fatal':
          handshake.reject(new Error(frame.message))
          return
        case 'log':
          options.log(frame.line)
          return
        case 'terminal-run':
          void answerTerminal(child, frame, options, terminals)
          return
        case 'terminal-cancel':
          terminals.get(frame.id)?.abort()
          terminals.delete(frame.id)
          return
        case 'open-file':
          void (async () => {
            const runner = options.openFile
            const outcome = runner === undefined
              ? { ok: false, error: 'the extension has no editor integration' }
              : await runner(frame.path)
            child.stdin?.write(`${JSON.stringify({
              type: 'open-file-result',
              id: frame.id,
              ok: outcome.ok,
              ...outcome.error === undefined ? {} : { error: outcome.error },
            })}\n`)
          })()
          return
        case 'fetch-result':
          // The opt-in binary answer carries bytes and a media type instead of text.
          forward('base64' in frame
            ? { type: 'fetch-result', id: frame.id, status: frame.status, base64: frame.base64, contentType: frame.contentType }
            : { type: 'fetch-result', id: frame.id, status: frame.status, body: frame.body })
          return
        case 'stream-item':
          forward({ type: 'stream-item', id: frame.id, item: frame.item })
          return
        case 'stream-end':
          forward({
            type: 'stream-end',
            id: frame.id,
            ...frame.error === undefined ? {} : { error: frame.error },
          })
          return
        case 'stream-uplink-ack':
          forward({ type: 'stream-uplink-ack', id: frame.id, seq: frame.seq })
          return
        case 'upload-ack':
          forward({ type: 'upload-ack', id: frame.id, seq: frame.seq })
          return
        case 'upload-result':
          forward({ type: 'upload-result', id: frame.id, status: frame.status, body: frame.body })
          return
        case 'asset-result':
          // The companion names filesystem paths; this side is the only place
          // that knows the Webview URI for them, for the requested asset and
          // for every asset prepared beside its bundle.
          forward({
            type: 'asset-result',
            id: frame.id,
            ...frame.uri === undefined ? {} : { uri: webview.asUri(frame.uri) },
            ...frame.assets === undefined ? {} : { assets: mapAssetPaths(frame.assets, webview) },
            ...frame.error === undefined ? {} : { error: frame.error },
          })
          return
        case 'activity-result': {
          const pending = bridge.activities.get(frame.id)
          bridge.activities.delete(frame.id)
          pending?.resolve(frame.activity)
          return
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text !== '') options.log(text)
    })
    child.on('exit', (code, signal) => {
      bridge.child = undefined
      bridge.settleActivities(`dsh: the companion host exited (code ${String(code)})`)
      bridge.settleExit?.()
      bridge.settleExit = undefined
      options.log(`dsh: companion exited with ${String(code)}`)
      if (bridge.payload === undefined) {
        handshake.reject(new Error('dsh: the companion host exited during startup'))
        return
      }
      if (!bridge.stopping) {
        bridge.settlePending(`dsh: the companion host exited (code ${String(code)})`)
        options.onExit?.({ code, signal })
      }
    })
    child.on('error', (error) => {
      bridge.child = undefined
      bridge.settleActivities(`dsh: the companion host failed: ${messageOf(error)}`)
      bridge.settleExit?.()
      bridge.settleExit = undefined
      if (bridge.payload === undefined) handshake.reject(error)
      else if (!bridge.stopping) {
        bridge.settlePending(`dsh: the companion host failed: ${messageOf(error)}`)
        options.onExit?.({ code: null, signal: null })
      }
    })
    await handshake.promise
    return bridge
  }

  /**
   * Tell the Webview that this transport ended so every pending fetch, upload,
   * asset request, uplink acknowledgement, and stream settles instead of
   * waiting for a process that is gone.
   * @param reason - what ended the transport.
   * @param deliberate - whether the extension stopped the Host on purpose, so
   * the page can settle an in-flight restart request as its own restart rather
   * than as a failure.
   */
  private settlePending(reason: string, deliberate = false): void {
    const webview = this.webview
    if (webview === undefined) return
    const frame = { type: 'transport-reset', reason, ...deliberate ? { deliberate: true } : {} }
    void Promise.resolve(webview.postMessage(frame)).catch((error: unknown) => {
      this.log(`dsh: the transport reset could not reach the Webview: ${messageOf(error)}`)
    })
  }

  /**
   * Ask the companion what it is running.
   *
   * The extension cannot observe a companion's Agents, terminals, or package operations, so a restart that must not
   * interrupt work asks here. A timeout or an exit rejects instead of answering zero: an unanswered query means the
   * work is unknown, not that none is running.
   * @param timeoutMs - how long to wait for the answer.
   * @returns the running counts.
   * @throws when no companion is running or it did not answer in time.
   */
  async activity(timeoutMs = 2_000): Promise<CompanionActivity> {
    const child = this.child
    if (child === undefined) throw new Error('dsh: companion host is not running')
    const id = ++this.activitySeq
    const answer = new Promise<CompanionActivity>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activities.delete(id)
        reject(new Error(`dsh: the companion did not answer the activity query within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.activities.set(id, {
        resolve: (activity) => { clearTimeout(timer); resolve(activity) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
    child.stdin?.write(`${JSON.stringify({ type: 'activity-query', id })}\n`)
    return await answer
  }

  /**
   * Refuse every pending activity query.
   * @param reason - why no answer can arrive.
   */
  private settleActivities(reason: string): void {
    for (const pending of this.activities.values()) pending.reject(new Error(reason))
    this.activities.clear()
  }

  /** Boot payload with webview URIs. */
  async prepare(): Promise<WebviewBootPayload> {
    if (this.payload !== undefined) return this.payload
    if (this.ready === undefined) throw new Error('dsh: the companion handshake has not started')
    return await this.ready
  }

  /**
   * Forward one webview message to the companion.
   * @param message - decoded webview message.
   */
  async handle(message: unknown): Promise<void> {
    const child = this.child
    if (child === undefined) throw new Error('dsh: companion host is not running')
    child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  /** Stop the companion process and wait for it to exit. */
  async dispose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    if (this.stopping) return
    this.stopping = true
    this.settleActivities('dsh: the DSH host stopped')
    // A page that outlives this process would otherwise wait for answers the
    // companion can no longer send. The flag marks this stop as the
    // extension's own restart, so the page settles an in-flight restart request
    // without reporting a crash.
    this.settlePending('the DSH host stopped', true)
    try {
      child.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      child.stdin?.end()
    } catch (error) {
      this.log(`dsh: could not request companion shutdown: ${messageOf(error)}`)
    }
    if (await settlesWithin(this.exited, 5_000)) return
    this.log('dsh: companion did not exit after shutdown; terminating it')
    child.kill()
    if (await settlesWithin(this.exited, 5_000)) return
    throw new Error('dsh: companion host did not terminate')
  }

}

/**
 * Wait for a promise without allowing shutdown to hang forever.
 * @param promise - operation to observe.
 * @param timeoutMs - maximum wait.
 * @returns whether the promise settled before the deadline.
 */
async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => { resolve(false) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one companion-requested command in the VS Code terminal and answer it.
 * @param child - the companion process.
 * @param frame - the terminal request.
 * @param options - the start options carrying the runner.
 */
async function answerTerminal(
  child: ChildProcess,
  frame: {
    id: number
    command: string
    cwd: string
    timeoutMs: number
    onExpiry: 'kill' | 'none'
    stdoutMaxBytes: number
    env?: Record<string, string>
  },
  options: CompanionOptions,
  terminals: Map<number, AbortController>,
): Promise<void> {
  const runner = options.runInTerminal
  const controller = new AbortController()
  terminals.set(frame.id, controller)
  const outcome: TerminalRunResult = runner === undefined
    ? { ok: false, error: 'the extension has no terminal runner' }
    : await runner(frame.command, frame.cwd, {
      timeoutMs: frame.timeoutMs,
      onExpiry: frame.onExpiry,
      stdoutMaxBytes: frame.stdoutMaxBytes,
      ...frame.env === undefined ? {} : { env: frame.env },
      signal: controller.signal,
    })
  terminals.delete(frame.id)
  const answer = outcome.ok
    ? {
        type: 'terminal-result',
        id: frame.id,
        ok: true,
        output: outcome.run.output,
        exitCode: outcome.run.exitCode,
        timedOut: outcome.run.timedOut,
        aborted: outcome.run.aborted,
        truncated: outcome.run.truncated,
      }
    : { type: 'terminal-result', id: frame.id, ok: false, error: outcome.error }
  child.stdin?.write(`${JSON.stringify(answer)}\n`)
}

/**
 * Map the companion's absolute paths to webview URIs.
 * @param payload - raw payload from the companion.
 * @param webview - the webview that serves them.
 * @returns the payload the document embeds.
 */
export function mapPayload(payload: RawPayload, webview: WebviewHost): WebviewBootPayload {
  return {
    injections: payload.injections,
    assets: mapAssetPaths(payload.assets, webview),
    shell: webview.asUri(payload.shell),
    styles: payload.styles.map(style => webview.asUri(style)),
    limits: payload.limits,
  }
}

/**
 * Map every local asset path the companion prepared to its webview URI.
 * @param paths - asset reference mapped to a companion-side filesystem path.
 * @param webview - the webview that serves them.
 * @returns the same references mapped to webview URIs.
 */
function mapAssetPaths(
  paths: Readonly<Record<string, string>>,
  webview: WebviewHost,
): Record<string, string> {
  const assets: Record<string, string> = {}
  for (const [reference, path] of Object.entries(paths)) assets[reference] = webview.asUri(path)
  return assets
}
