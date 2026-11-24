/**
 * Window transport over one shared-host connection.
 *
 * Unlike the per-window companion bridge, this class never starts a process of
 * its own: the shared host owns the application and every window attaches to it.
 * The ready payload's paths are mapped to this window's Webview URIs, frames are
 * validated before they reach the page, and an unexpected host disconnect
 * settles the page with a transport reset.
 *
 * @module @deepseek-ai/dsh-vscode/host/shared-bridge
 */
import type { WebviewBootPayload, WebviewHost } from './bridge.ts'
import type { CompanionActivity } from './companion-bridge.ts'
import { isChildFrame, mapPayload, type ChildFrame, type RawPayload } from './companion-bridge.ts'
import type { TerminalRunOptions, TerminalRunResult } from './terminal.ts'
import { connectSharedHost, type SharedHostConnection } from './host-client.ts'
import { isHostActivityAnswer, isHostConfigAnswer, isHostMaintenanceNotice, isHostShutdownAnswer, type HostActivityCounts, type HostHelloOk, type HostMaintenanceNotice, type HostModelConfig } from '../shared/host-protocol.ts'
import { readBridgeLimits, type BridgeLimits } from '../shared/limits.ts'

/** Inputs for one window attach. */
export interface SharedHostBridgeOptions {
  /** Shared host endpoint. */
  readonly endpoint: string
  /** Credential published in the storage's token file. */
  readonly token: string
  /** Stable identity of this window activation. */
  readonly clientId: string
  /** Extension version reported in the handshake. */
  readonly extensionVersion: string
  /** Deployment settings fingerprint this window would boot with. */
  readonly configFingerprint: string
  /** Bounded-transfer budgets this window's Webview enforces. */
  readonly limits: BridgeLimits
  /** Workspace folder this window shows, when it has one. */
  readonly workspacePath?: string
  /** The webview whose URIs and message channel this bridge serves. */
  readonly webview: WebviewHost
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** Reports an unexpected host disconnect; a deliberate dispose does not call it. */
  readonly onExit?: (reason: string) => void
  /**
   * Reports that the host closed or reopened admission for new work.
   *
   * Every window receives the notice, including the one that requested the stop
   * and the ones that did not.
   */
  readonly onMaintenance?: (active: boolean, reason?: string) => void
  /**
   * Runs a command in this window's VS Code terminal.
   *
   * The shared host executes every window's tools, so it asks a connected window
   * to run the command and read the answer back over the same connection.
   */
  readonly runInTerminal?: (command: string, cwd: string, options: TerminalRunOptions) => Promise<TerminalRunResult>
  /** Shows one file in this window's VS Code editor. */
  readonly openFile?: (path: string) => Promise<{ ok: boolean; error?: string }>
  /** Handshake deadline; defaults to the client's value. */
  readonly handshakeTimeoutMs?: number
}

/** One window's transport over a shared-host connection. */
export class SharedHostBridge {
  private readonly activities = new Map<number, {
    resolve(counts: HostActivityCounts): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  }>()
  private readonly controls = new Map<number, {
    resolve(answer: { readonly ok: boolean; readonly error?: string }): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  }>()
  private readonly configs = new Map<number, {
    resolve(config: HostModelConfig): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  }>()
  private activitySeq = 0
  private controlSeq = 0
  private configSeq = 0
  /** Terminal commands the host asked this window to run, by request id. */
  private readonly terminals = new Map<number, AbortController>()
  private disposing = false
  private reported = false
  private endedReason: string | undefined

  /**
   * @param connection - admitted host connection.
   * @param payload - boot payload with this window's URIs.
   * @param webview - the webview that receives frames.
   * @param log - diagnostic sink.
   * @param onExit - unexpected disconnect reporter.
   * @param runInTerminal - runs a command in this window's terminal.
   * @param openFile - shows one file in this window's editor.
   */
  private constructor(
    private readonly connection: SharedHostConnection,
    private readonly payload: WebviewBootPayload,
    private readonly webview: WebviewHost,
    private readonly log: (line: string) => void,
    private readonly onExit: ((reason: string) => void) | undefined,
    private readonly runInTerminal: SharedHostBridgeOptions['runInTerminal'],
    private readonly openFile: SharedHostBridgeOptions['openFile'],
    private readonly onMaintenance: SharedHostBridgeOptions['onMaintenance'],
  ) {}

  /**
   * Attach to a running shared host.
   * @param options - endpoint, credential, identity, limits, and sinks.
   * @returns the attached bridge.
   * @throws when the host refuses this window (`token`, `protocol`, or `capacity`).
   * @throws when the host is unreachable or its boot payload is malformed.
   */
  static async start(options: SharedHostBridgeOptions): Promise<SharedHostBridge> {
    const holder: { bridge?: SharedHostBridge } = {}
    let ended: string | undefined
    let initialMaintenance: HostMaintenanceNotice | undefined
    const connection = await connectSharedHost({
      endpoint: options.endpoint,
      token: options.token,
      clientId: options.clientId,
      extensionVersion: options.extensionVersion,
      configFingerprint: options.configFingerprint,
      limits: options.limits,
      ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
      onFrame: (frame) => {
        if (holder.bridge !== undefined) holder.bridge.receive(frame)
        else if (isHostMaintenanceNotice(frame)) initialMaintenance = frame
      },
      onClose: (reason) => {
        ended ??= reason
        holder.bridge?.transportEnded(reason)
      },
      log: options.log,
      ...options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs },
    })
    const raw = readRawPayload(connection.ready)
    if (raw === undefined) {
      connection.close()
      throw new Error('dsh: the shared DSH host sent an incomplete boot payload')
    }
    const bridge = new SharedHostBridge(
      connection,
      mapPayload(raw, options.webview),
      options.webview,
      options.log,
      options.onExit,
      options.runInTerminal,
      options.openFile,
      options.onMaintenance,
    )
    holder.bridge = bridge
    // The host can close between the admitted answer and this assignment; the
    // page still needs its reset instead of waiting for a transport that is gone.
    if (ended !== undefined) bridge.transportEnded(ended)
    else if (initialMaintenance !== undefined) bridge.receive(initialMaintenance)
    return bridge
  }

  /**
   * @param _shellRoot - accepted for the per-window bridge interface; the shared
   * host already materialized the bundles this payload names.
   * @returns the boot payload with this window's URIs.
   */
  prepare(_shellRoot: string): Promise<WebviewBootPayload> {
    return Promise.resolve(this.payload)
  }

  /** The host's admission answer, including the fingerprint it booted with. */
  get hello(): HostHelloOk {
    return this.connection.hello
  }

  /**
   * Forward one Webview message to the shared host.
   * @param message - decoded message.
   * @returns settles once the frame is written to the connection.
   */
  handle(message: unknown): Promise<void> {
    this.connection.send(message)
    return Promise.resolve()
  }

  /**
   * Ask the host what work it is running.
   *
   * The host owns every window's turns, terminals, and package operations, so
   * the answer is host-wide; the extension uses it to refuse a maintenance stop
   * of another window's work.
   * @param timeoutMs - how long to wait for the answer.
   * @returns the running counts.
   * @throws when the transport ended or the host did not answer in time.
   */
  async activity(timeoutMs = 2_000): Promise<CompanionActivity> {
    if (this.endedReason !== undefined) throw new Error(this.endedReason)
    const id = ++this.activitySeq
    const answer = new Promise<HostActivityCounts>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activities.delete(id)
        reject(new Error(`dsh: the shared DSH host did not answer the activity query within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.activities.set(id, {
        resolve: (counts) => { clearTimeout(timer); resolve(counts) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
    })
    this.connection.send({ type: 'host-activity', id })
    return await answer
  }

  /**
   * Ask the shared host to stop for maintenance.
   *
   * The host refuses while any window's turn, terminal command, or package
   * operation is running. An accepted stop closes every connection, so this
   * window's transport ends after the answer and other windows see a reset.
   * @param timeoutMs - how long to wait for the answer.
   * @returns whether the host accepted the stop, and why it refused.
   * @throws when the transport already ended or no answer arrives in time.
   */
  async shutdownHost(timeoutMs = 5_000): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (this.endedReason !== undefined) throw new Error(this.endedReason)
    const id = ++this.controlSeq
    const answer = new Promise<{ readonly ok: boolean; readonly error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id)
        reject(new Error(`dsh: the shared DSH host did not answer the shutdown request within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.controls.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
    })
    this.connection.send({ type: 'host-shutdown', id })
    return await answer
  }

  /**
   * Ask the host for the deployment model configuration it booted with.
   *
   * The shared host runs one application, so this is the effective route and
   * model for every window, including one whose own saved settings differ.
   * @param timeoutMs - how long to wait for the answer.
   * @returns the route, model, and whether a model is configured.
   * @throws when the connection ended, the answer did not arrive, or it is malformed.
   */
  async modelConfig(timeoutMs = 2_000): Promise<HostModelConfig> {
    if (this.endedReason !== undefined) throw new Error(this.endedReason)
    const id = ++this.configSeq
    const answer = new Promise<HostModelConfig>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configs.delete(id)
        reject(new Error(`dsh: the shared DSH host did not answer the model-configuration query within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.configs.set(id, {
        resolve: (config) => { clearTimeout(timer); resolve(config) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
    })
    this.connection.send({ type: 'host-config', id })
    return await answer
  }

  /** Close this window's connection; the shared host keeps running for other windows. */
  dispose(): Promise<void> {
    if (this.disposing) return Promise.resolve()
    this.disposing = true
    this.endedReason ??= 'dsh: the window closed its shared host connection'
    this.stopTerminals()
    this.settleActivities(new Error(this.endedReason))
    this.settleConfigs(new Error(this.endedReason))
    this.settleControls(new Error(this.endedReason))
    this.connection.close()
    return Promise.resolve()
  }

  /**
   * Run one command the host asked this window's terminal to execute.
   * @param frame - terminal request from the host.
   */
  private async runTerminalFrame(frame: {
    readonly id: number
    readonly command: string
    readonly cwd: string
    readonly timeoutMs: number
    readonly onExpiry: 'kill' | 'none'
    readonly stdoutMaxBytes: number
    readonly env?: Record<string, string>
  }): Promise<void> {
    const controller = new AbortController()
    this.terminals.set(frame.id, controller)
    const runner = this.runInTerminal
    let outcome: TerminalRunResult
    try {
      outcome = runner === undefined
        ? { ok: false, error: 'the extension has no terminal runner' }
        : await runner(frame.command, frame.cwd, {
          timeoutMs: frame.timeoutMs,
          onExpiry: frame.onExpiry,
          stdoutMaxBytes: frame.stdoutMaxBytes,
          ...frame.env === undefined ? {} : { env: frame.env },
          signal: controller.signal,
        })
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.terminals.delete(frame.id)
    }
    this.connection.send(outcome.ok
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
      : { type: 'terminal-result', id: frame.id, ok: false, error: outcome.error })
  }

  /**
   * Show one file the host asked this window's editor to open.
   * @param frame - editor request from the host.
   */
  private async openFileFrame(frame: { readonly id: number; readonly path: string }): Promise<void> {
    const runner = this.openFile
    let outcome: { ok: boolean; error?: string }
    try {
      outcome = runner === undefined
        ? { ok: false, error: 'the extension has no editor integration' }
        : await runner(frame.path)
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.connection.send({
      type: 'open-file-result',
      id: frame.id,
      ok: outcome.ok,
      ...outcome.error === undefined ? {} : { error: outcome.error },
    })
  }

  /** Abort every terminal command this window is still running for the host. */
  private stopTerminals(): void {
    for (const controller of this.terminals.values()) controller.abort()
    this.terminals.clear()
  }

  /**
   * @param frame - one decoded host frame.
   */
  private receive(frame: unknown): void {
    if (isHostActivityAnswer(frame)) {
      const pending = this.activities.get(frame.id)
      this.activities.delete(frame.id)
      pending?.resolve(frame.activity)
      return
    }
    if (isHostShutdownAnswer(frame)) {
      const pending = this.controls.get(frame.id)
      this.controls.delete(frame.id)
      pending?.resolve({ ok: frame.ok, ...frame.error === undefined ? {} : { error: frame.error } })
      return
    }
    if (isHostConfigAnswer(frame)) {
      const pending = this.configs.get(frame.id)
      this.configs.delete(frame.id)
      pending?.resolve(frame.config)
      return
    }
    if (isHostMaintenanceNotice(frame)) {
      this.log(`dsh host: maintenance admission ${frame.active ? 'closed' : 'reopened'}${frame.reason === undefined ? '' : `: ${frame.reason}`}`)
      this.onMaintenance?.(frame.active, frame.reason)
      return
    }
    if (typeof frame !== 'object' || frame === null || typeof (frame as { type?: unknown }).type !== 'string') {
      this.log('dsh: the shared DSH host sent an unknown frame; it was ignored')
      return
    }
    const child = frame as ChildFrame
    if (!isChildFrame(child)) {
      this.log('dsh: the shared DSH host sent an incomplete frame; it was ignored')
      return
    }
    switch (child.type) {
      case 'terminal-run':
        void this.runTerminalFrame(child)
        return
      case 'terminal-cancel':
        this.terminals.get(child.id)?.abort()
        this.terminals.delete(child.id)
        return
      case 'open-file':
        void this.openFileFrame(child)
        return
      case 'asset-result': {
        const assets: Record<string, string> = {}
        for (const [reference, path] of Object.entries(child.assets ?? {})) assets[reference] = this.webview.asUri(path)
        this.post({
          type: 'asset-result',
          id: child.id,
          ...child.uri === undefined ? {} : { uri: this.webview.asUri(child.uri) },
          ...child.assets === undefined ? {} : { assets },
          ...child.error === undefined ? {} : { error: child.error },
        })
        return
      }
      default:
        this.post(child)
    }
  }

  /**
   * Report that the transport ended: settle pending activity queries, reset the
   * page, and let the host state report the failure.
   * @param reason - why the transport ended.
   */
  private transportEnded(reason: string): void {
    this.endedReason ??= reason
    this.stopTerminals()
    this.settleActivities(new Error(reason))
    this.settleControls(new Error(reason))
    this.settleConfigs(new Error(reason))
    if (this.disposing || this.reported) return
    this.reported = true
    this.post({ type: 'transport-reset', reason })
    this.onExit?.(reason)
  }

  /**
   * @param error - why no answer can arrive.
   */
  private settleActivities(error: Error): void {
    for (const pending of this.activities.values()) pending.reject(error)
    this.activities.clear()
  }

  /**
   * @param error - why no shutdown answer can arrive.
   */
  private settleControls(error: Error): void {
    for (const pending of this.controls.values()) pending.reject(error)
    this.controls.clear()
  }

  /**
   * @param error - why no model-configuration answer can arrive.
   */
  private settleConfigs(error: Error): void {
    for (const pending of this.configs.values()) pending.reject(error)
    this.configs.clear()
  }

  /**
   * @param frame - frame to deliver to this window's webview.
   */
  private post(frame: unknown): void {
    void Promise.resolve(this.webview.postMessage(frame)).catch((error: unknown) => {
      this.log(`dsh: a frame could not reach the Webview: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/**
 * Validate the boot payload before its paths are mapped to Webview URIs.
 * @param value - decoded `ready` payload.
 * @returns the payload, or undefined when a required field is missing.
 */
function readRawPayload(value: unknown): RawPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload.injections)) return undefined
  if (typeof payload.shell !== 'string') return undefined
  if (!Array.isArray(payload.styles) || !payload.styles.every(style => typeof style === 'string')) return undefined
  if (typeof payload.assets !== 'object' || payload.assets === null) return undefined
  const limits = readBridgeLimits(payload.limits)
  if (limits === undefined) return undefined
  const assets: Record<string, string> = {}
  for (const [reference, path] of Object.entries(payload.assets)) {
    if (typeof path !== 'string') return undefined
    assets[reference] = path
  }
  return {
    injections: payload.injections,
    assets,
    shell: payload.shell,
    styles: payload.styles,
    limits,
  }
}
