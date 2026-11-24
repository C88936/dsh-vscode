/**
 * The DSH webview view.
 *
 * Before the application is ready the view renders host state; once the tree
 * is live it hosts the DSH client shell over the transport bridge.
 * @module @deepseek-ai/dsh-vscode/view/chat-view
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { DshHost, HostBridge, HostSnapshot } from '../host/host.ts'
import type { WebviewBootPayload } from '../host/bridge.ts'
import type { DiffDocuments, DiffRequest } from '../host/diff.ts'
import { openFileInEditor } from '../host/editor.ts'
import { isPickLocalPathMessage, pickLocalPath } from '../host/local-path-picker.ts'
import { providerModelIdError } from '../host/settings.ts'
import { writeEffectiveSetting } from '../host/configuration.ts'
import { modelStatusText } from '../shared/model-status.ts'
import type { HostModelConfig } from '../shared/host-protocol.ts'

/** One resource, external URL, or comparison the webview asks the host to open. */
type HostOpenMessage =
  | {
    readonly type: 'open-resource'
    readonly id: number
    readonly request: { readonly address: string; readonly path?: string; readonly line?: number }
  }
  | { readonly type: 'open-external'; readonly id: number; readonly url: string }
  | { readonly type: 'open-diff'; readonly id: number; readonly request: DiffRequest }

/** One page request to restart the application, which the extension answers with the existing restart command. */
interface RestartHostMessage {
  readonly type: 'restart-host'
  readonly id: number
}

/**
 * One page request to save the deployment route's model id.
 *
 * The value is written to global `dsh.llmModel`, which the generated launch
 * overlay reads on the next launch. It is never written to the DSH profile:
 * the overlay would replace a profile value, and the profile belongs to the
 * user's own routes.
 */
interface SetProviderModelMessage {
  readonly type: 'set-provider-model'
  readonly id: number
  readonly model: string
}

/** Largest comparison accepted from the page: both sides together. */
const MAX_DIFF_CHARS = 4_000_000

/** First delay before a failed page asks the host to attach again, in milliseconds. */
const FIRST_RECONNECT_DELAY_MS = 500

/** Longest delay between automatic reconnect attempts, in milliseconds. */
const MAX_RECONNECT_DELAY_MS = 5_000

/** Webview view provider for the DSH chat surface. */
export class DshChatView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private bridge: HostBridge | undefined
  private bridgeRevision = -1
  private state: HostSnapshot | undefined
  private refreshing: Promise<void> | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private reconnectDelayMs = FIRST_RECONNECT_DELAY_MS
  private configMismatchWarned = false
  private modelStatus: vscode.StatusBarItem | undefined
  private modelNoticeShown = false
  private readonly disposeHostListener: () => void

  /**
   * @param extensionUri - extension root, for the bootstrap script and assets.
   * @param host - the DSH host this view observes.
   * @param log - diagnostic sink.
   * @param diffs - virtual documents for native before/after comparisons.
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: DshHost,
    private readonly log: (line: string) => void,
    private readonly diffs: DiffDocuments,
  ) {
    this.disposeHostListener = host.onChange(() => { this.renderHostChange() })
  }

  /**
   * Bind the resolved view and paint the current state.
   * @param webviewView - the view VS Code resolved.
   */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    const messageListener = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isPickLocalPathMessage(message)) {
        void pickLocalPath({ showOpenDialog: options => vscode.window.showOpenDialog(options) }, message)
          .then(answer => webviewView.webview.postMessage(answer))
          .catch((error: unknown) => {
            this.log(`dsh: webview selection request failed: ${describe(error)}`)
          })
        return
      }
      if (isHostOpenMessage(message)) {
        void this.answerHostOpen(webviewView.webview, message).catch((error: unknown) => {
          this.log(`dsh: webview open request failed: ${describe(error)}`)
        })
        return
      }
      if (isRestartHostMessage(message)) {
        void this.answerRestart(webviewView.webview, message).catch((error: unknown) => {
          this.log(`dsh: webview restart request failed: ${describe(error)}`)
        })
        return
      }
      if (isSetProviderModelMessage(message)) {
        void this.answerSetProviderModel(webviewView.webview, message).catch((error: unknown) => {
          this.log(`dsh: webview provider model request failed: ${describe(error)}`)
        })
        return
      }
      void this.bridge?.handle(message).catch((error: unknown) => {
        this.log(`dsh: webview bridge failed: ${describe(error)}`)
      })
    })
    const disposeListener = webviewView.onDidDispose?.(() => {
      messageListener.dispose()
      disposeListener?.dispose()
      this.disposeHostListener()
      void this.dispose()
    })
    void this.refresh()
  }

  /** Re-render the view from the host's current state. */
  refresh(): Promise<void> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /**
   * Re-read the running deployment model after a saved settings change.
   *
   * The host keeps the model it launched with, so the new value is shown as a
   * difference until the user restarts; the status bar and the view header
   * both carry that state.
   */
  refreshModelStatus(): void {
    void this.reportModelConfig()
  }

  /**
   * Forward one extension-scoped shortcut to the DSH shell.
   * @param command - DSH command the page's shortcut registry should run.
   */
  command(command: 'session.new' | 'session.search' | 'session.fork'): void {
    const webview = this.view?.webview
    if (webview === undefined) return
    void webview.postMessage({ type: 'dsh-command', command })
  }

  /**
   * Close the page's Host transport so it cannot start new work.
   *
   * A restart confirms the running work and then stops the application; between those steps the page could still
   * submit a turn that the stop would then interrupt. Closing the transport first makes every later call fail with
   * the transport's own closed error, and {@link refresh} installs a live one after the restart.
   * @param reason - why the transport ended, shown to the page's callers.
   */
  async freezeTransport(reason: string): Promise<void> {
    const webview = this.view?.webview
    if (webview === undefined) return
    try {
      await webview.postMessage({ type: 'transport-reset', reason, deliberate: true })
    } catch (error) {
      // The page may already be gone; the restart proceeds without it.
      this.log(`dsh: the transport reset could not reach the Webview: ${describe(error)}`)
    }
  }

  private async refreshOnce(): Promise<void> {
    const view = this.view
    if (view === undefined) return
    await this.host.start()
    this.state = this.host.snapshot()
    if (this.state.state === 'failed') {
      view.webview.html = this.renderStatus(this.state)
      return
    }
    if (this.state.state === 'stopping' || this.state.state === 'stopped') {
      view.webview.html = this.renderStatus(this.state)
      return
    }
    if (this.bridge !== undefined && this.bridgeRevision === this.host.revision && this.state.state === 'ready') {
      return
    }
    try {
      const shellRoot = this.host.shellRoot
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(this.host.storageDir),
          vscode.Uri.file(shellRoot),
        ],
      }
      await this.bridge?.dispose()
      const bridge = await this.host.createBridge({
        asUri: path => view.webview.asWebviewUri(vscode.Uri.file(path)).toString(),
        postMessage: message => view.webview.postMessage(message),
      })
      this.bridge = bridge
      this.bridgeRevision = this.host.revision
      const payload = await bridge.prepare(shellRoot)
      view.webview.html = this.renderShell(payload)
      this.warnConfigMismatch()
      void this.reportModelConfig()
    } catch (error) {
      this.log(`dsh: shell render failed: ${describe(error)}`)
      view.webview.html = this.renderStatus({ ...this.state, state: 'failed', detail: describe(error) })
    }
  }

  /**
   * Open one resource or URL the DSH client asked for and answer the request.
   * @param webview - webview that sent the request.
   * @param message - validated request.
   */
  private async answerHostOpen(webview: vscode.Webview, message: HostOpenMessage): Promise<void> {
    let ok = true
    let error: string | undefined
    switch (message.type) {
      case 'open-external': {
        const uri = vscode.Uri.parse(message.url, true)
        if (uri.scheme !== 'http' && uri.scheme !== 'https') {
          ok = false
          error = 'Only HTTP(S) links open in the system browser.'
        } else {
          ok = await vscode.env.openExternal(uri)
          if (!ok) error = 'The system browser could not open the link.'
        }
        break
      }
      case 'open-resource': {
        if (message.request.path === undefined) {
          ok = false
          error = 'This resource has no file editor in VS Code.'
        } else {
          try {
            const outcome = await openFileInEditor(message.request.path, this.host.workspacePath, message.request.line)
            ok = outcome.ok
            error = outcome.error
          } catch (failure) {
            ok = false
            error = describe(failure)
          }
        }
        break
      }
      case 'open-diff': {
        if (message.request.before.length + message.request.after.length > MAX_DIFF_CHARS) {
          ok = false
          error = vscode.l10n.t('This comparison is too large to open in the editor.')
          break
        }
        try {
          await this.diffs.show(message.request)
        } catch (failure) {
          ok = false
          error = `The comparison could not open: ${describe(failure)}`
        }
        break
      }
    }
    if (!ok) void vscode.window.showWarningMessage(error ?? 'DSH could not open the requested item.')
    await webview.postMessage({ type: 'open-result', id: message.id, ok, ...error === undefined ? {} : { error } })
  }

  /**
   * Run the existing restart command for a page that asked for it. A successful restart replaces this page,
   * so its answer reaches the Webview only when the command was refused or failed; either is also shown in VS Code.
   * @param webview - webview that sent the request.
   * @param message - validated restart request.
   */
  private async answerRestart(webview: vscode.Webview, message: RestartHostMessage): Promise<void> {
    let ok = true
    let error: string | undefined
    try {
      await vscode.commands.executeCommand('dsh.restart')
    } catch (failure) {
      ok = false
      // The command rejects on running work it cannot stop, a failed boot, or a view that could not repaint. None of
      // those means the saved plugin changes took effect, so the answer must let the page keep its pending state.
      error = `The DSH host did not restart: ${describe(failure)}`
      void vscode.window.showErrorMessage(error)
    }
    try {
      await webview.postMessage({ type: 'restart-result', id: message.id, ok, ...error === undefined ? {} : { error } })
    } catch (postError) {
      // A successful restart replaces the page, so its answer has no reader left.
      this.log(`dsh: restart answer could not reach the Webview: ${describe(postError)}`)
    }
  }

  /**
   * Save the deployment route's model id as global VS Code configuration.
   *
   * An unusable id is refused before anything is written, so the page keeps its
   * draft. A saved value reaches the running host only on the next launch; the
   * existing settings-change notice offers that restart. The profile is not
   * written: the generated overlay replaces these deployment values.
   * @param webview - webview that sent the request.
   * @param message - validated request carrying the listed model id.
   */
  private async answerSetProviderModel(webview: vscode.Webview, message: SetProviderModelMessage): Promise<void> {
    const model = message.model.trim()
    const refusal = providerModelIdError(model)
    let ok = refusal === undefined
    let error = refusal
    if (ok) {
      try {
        const written = await writeEffectiveSetting('llmModel', model)
        this.log(
          `dsh: deployment model saved as dsh.llmModel (${model})`
          + `${written.target === vscode.ConfigurationTarget.Global ? '' : ' in the workspace layer'}`,
        )
      } catch (failure) {
        error = `The model could not be saved to dsh.llmModel: ${describe(failure)}`
        void vscode.window.showErrorMessage(`DSH: ${error}`)
        ok = false
      }
    } else {
      void vscode.window.showWarningMessage(`DSH did not save that model id: ${refusal}`)
    }
    await webview.postMessage({ type: 'set-provider-model-result', id: message.id, ok, ...error === undefined ? {} : { error } })
  }

  private renderHostChange(): void {
    const view = this.view
    if (view === undefined) return
    const state = this.host.snapshot()
    if (state.state === 'ready') {
      // A recovered host clears the backoff and lets the next refresh build a
      // bridge for the new connection generation.
      this.clearReconnect()
      if (this.bridgeRevision !== this.host.revision) void this.refresh()
      return
    }
    if (state.state === 'failed') {
      this.state = state
      this.configMismatchWarned = false
      view.webview.html = this.renderStatus(state)
      // Another window can restart the shared host, or the host can crash and be
      // started again by any window; every window retries on its own so none
      // needs a manual reload to recover.
      this.scheduleReconnect()
      return
    }
    if (state.state === 'stopped' || state.state === 'stopping') {
      this.clearReconnect()
      this.state = state
      view.webview.html = this.renderStatus(state)
    }
  }

  /** Schedule the next automatic attach attempt with a growing delay. */  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.view === undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnect()
    }, this.reconnectDelayMs)
  }

  /** Stop the reconnect backoff, for a ready, stopped, or disposed view. */
  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectDelayMs = FIRST_RECONNECT_DELAY_MS
  }

  /**
   * Tell this window when the shared host booted another window's deployment
   * settings, and offer the shared restart that applies this window's own.
   */
  private warnConfigMismatch(): void {
    if (!this.host.configMismatch || this.configMismatchWarned) return
    this.configMismatchWarned = true
    const restart = vscode.l10n.t('Restart DSH')
    const message = vscode.l10n.t(
      'The shared DSH host was started with different deployment settings or an extension version that differs from this window. Finish running work before a shared restart. After updating the extension, reload all VS Code windows.',
    )
    void Promise.resolve(vscode.window.showWarningMessage(message, restart))
      .then(async (choice) => {
        if (choice === restart) await vscode.commands.executeCommand('dsh.restart')
      })
      .catch((error: unknown) => {
        this.log(`dsh: the shared-restart request failed: ${describe(error)}`)
      })
  }

  /** Try to rebuild this page against the host, backing off while it stays down. */
  private async reconnect(): Promise<void> {
    if (this.view === undefined || this.host.snapshot().state === 'stopped') return
    try {
      await this.refresh()
    } catch (error) {
      this.log(`dsh: the automatic reconnect attempt failed: ${describe(error)}`)
    }
    if (this.host.snapshot().state === 'failed') {
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
      this.scheduleReconnect()
    }
  }

  private async dispose(): Promise<void> {
    this.clearReconnect()
    this.modelStatus?.dispose()
    this.modelStatus = undefined
    const bridge = this.bridge
    this.bridge = undefined
    this.bridgeRevision = -1
    this.view = undefined
    await bridge?.dispose()
    await this.host.stop()
  }

  /**
   * Show the running host's deployment model in this window, and offer the
   * company setup once when the host has no usable model.
   *
   * The host runs one application, so every window shows the same route and
   * model even when this window's saved settings would launch differently;
   * that difference stays visible in the status text and tooltip.
   */
  private async reportModelConfig(): Promise<void> {
    let config: HostModelConfig
    try {
      config = await this.host.modelConfig()
    } catch (error) {
      this.log(`dsh: the running model configuration is unavailable: ${describe(error)}`)
      return
    }
    const mismatch = this.host.configMismatch
    this.modelStatus ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.modelStatus.text = modelStatusText(config, mismatch)
    this.modelStatus.tooltip = config.configured
      ? `DSH runs ${config.provider}${config.model === '' ? '' : ` with ${config.model}`}${mismatch ? '; this window has a different launch configuration or extension version' : ''}`
      : 'DSH has no company model selected. Fetch the model list and choose one.'
    this.modelStatus.command = 'dsh.selectModel'
    this.modelStatus.show()
    if (this.view !== undefined) this.view.description = this.modelStatus.text
    if (config.configured || this.modelNoticeShown) return
    this.modelNoticeShown = true
    const choice = await vscode.window.showWarningMessage(
      'DSH has no company model selected yet. Fetch the available models and choose one.',
      'Select a model',
      'Configure company endpoint',
    )
    if (choice === 'Select a model') await vscode.commands.executeCommand('dsh.selectModel')
    else if (choice !== undefined) await vscode.commands.executeCommand('dsh.configureCompany')
  }

  private renderShell(payload: WebviewBootPayload): string {
    const nonce = randomBytes(16).toString('base64')
    const bootstrap = this.view?.webview.asWebviewUri(
      vscode.Uri.file(join(this.extensionUri.fsPath, 'lib', 'webview.iife.js')),
    ).toString() ?? ''
    const boot = JSON.stringify({ ...payload, nonce }).replaceAll('<', '\\u003c')
    const links = payload.styles.map(href => `<link rel="stylesheet" href="${href}">`).join('\n')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${this.csp(nonce)}">
${links}
<!-- VS Code's webview view defaults inherit the host scrollbar colors, which
     suppress the DSH WebKit scrollbar skin; the shell needs the auto value. -->
<style>html { scrollbar-color: auto; }</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">globalThis.__DSH_BOOT_PAYLOAD__ = ${boot};</script>
<script nonce="${nonce}" src="${bootstrap}"></script>
</body>
</html>`
  }

  private csp(nonce: string): string {
    const source = this.view?.webview.cspSource ?? ''
    return [
      "default-src 'none'",
      `style-src ${source} 'unsafe-inline'`,
      `script-src ${source} 'nonce-${nonce}' 'unsafe-eval'`,
      `img-src ${source} data: blob:`,
      `font-src ${source} data:`,
      `media-src ${source} data:`,
      "connect-src 'none'",
    ].join('; ')
  }

  private renderStatus(state: HostSnapshot): string {
    const nonce = randomBytes(16).toString('base64')
    const services = state.services.length === 0
      ? ''
      : `<ul>${state.services.map(name => `<li><code>ctx.${name}</code></li>`).join('')}</ul>`
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${this.csp(nonce)}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 12px; line-height: 1.5; margin: 0 0 8px; white-space: pre-wrap; }
  code { font-family: var(--vscode-editor-font-family); }
  ul { font-size: 12px; margin: 0; padding-left: 18px; }
  .state { text-transform: uppercase; font-size: 10px; letter-spacing: .08em; opacity: .7; }
</style>
</head>
<body>
<h1>DSH</h1>
<p class="state">${state.state} - ${state.mode}</p>
<p>${escapeHtml(state.detail)}</p>
${services}
</body>
</html>`
  }
}

/**
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate one webview message as a host open request.
 * @param value - decoded message from the webview.
 * @returns whether the message asks the host to open a resource or URL.
 */
function isHostOpenMessage(value: unknown): value is HostOpenMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; id?: unknown; url?: unknown; request?: unknown }
  if (typeof message.id !== 'number' || !Number.isInteger(message.id)) return false
  if (message.type === 'open-external') return typeof message.url === 'string'
  if (message.type === 'open-diff') {
    if (typeof message.request !== 'object' || message.request === null) return false
    const request = message.request as { title?: unknown; before?: unknown; after?: unknown }
    return typeof request.title === 'string'
      && typeof request.before === 'string'
      && typeof request.after === 'string'
  }
  if (message.type !== 'open-resource') return false
  if (typeof message.request !== 'object' || message.request === null) return false
  const request = message.request as { address?: unknown; path?: unknown; line?: unknown }
  if (typeof request.address !== 'string') return false
  if (request.path !== undefined && typeof request.path !== 'string') return false
  return request.line === undefined || typeof request.line === 'number'
}

/**
 * Validate one webview message as a host restart request.
 * @param value - decoded message from the webview.
 * @returns whether the message asks the host to restart the application.
 */
function isRestartHostMessage(value: unknown): value is RestartHostMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; id?: unknown }
  return message.type === 'restart-host' && typeof message.id === 'number' && Number.isInteger(message.id)
}

/**
 * Validate one webview message as a deployment-model save request.
 * @param value - decoded message from the webview.
 * @returns whether the message asks the host to save a model id.
 */
function isSetProviderModelMessage(value: unknown): value is SetProviderModelMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; id?: unknown; model?: unknown }
  return message.type === 'set-provider-model'
    && typeof message.id === 'number' && Number.isInteger(message.id)
    && typeof message.model === 'string'
}

/**
 * @param text - untrusted text. @returns HTML-escaped text.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
