/**
 * VS Code extension entry.
 *
 * Activation starts the managed DSH host and opens the DSH client shell in a
 * webview; deactivation disposes the host.
 * @module @deepseek-ai/dsh-vscode
 */
import * as vscode from 'vscode'
import { DshHost, describe, type WorkspaceChange } from './host/host.ts'
import { API_KEY_SECRET, companyKeySlot, type LaunchCredentials } from './host/env.ts'
import { runInTerminal } from './host/terminal.ts'
import { formatDiagnostics } from './host/diagnostics.ts'
import {
  changedProviderSettings,
  companyBaseUrlError,
  companySetupStatus,
  type CompanySetupField,
  type ProviderSettings,
} from './host/settings.ts'
import { DiffDocuments } from './host/diff.ts'
import { effectiveSettingWrite, writeEffectiveSetting } from './host/configuration.ts'
import { fetchCompanyModels, selectCompanyModel } from './host/model-select.ts'
import { UpdateController, type UpdateCheckOutcome } from './host/update/controller.ts'
import type { DownloadResult } from './host/update/download.ts'
import { installStagedUpdate } from './host/update/install.ts'
import { DshChatView } from './view/chat-view.ts'

let host: DshHost | undefined

/**
 * Work a restart would interrupt, as the extension can observe it.
 */
export interface RestartActivity {
  /** Live Agents running a turn. */
  readonly runningTurns: number
  /** Package operations the manager announced and has not settled. */
  readonly packageOperations: number
  /** Running DSH terminal commands: PTY sessions and the integrated terminal the extension creates. */
  readonly runningTerminals: number
}

/** The live-application services the restart check reads. */
interface RestartWorkContext {
  get(name: string): unknown
  on(event: 'plugin-manager/operation', listener: (operation: RestartOperation) => void): () => void
}

/** The part of one manager operation the check tracks. */
interface RestartOperation {
  readonly id: string
  readonly phase: string
}

/** One live Agent as the work check reads it. */
interface RestartAgent {
  readonly status: string
}

/** One live terminal as the work check reads it. */
interface RestartTerminal {
  readonly status: { readonly kind: string }
}

/** The restart refusal decision, separated from the host so a test can state the observed work. */
export interface RestartGuard {
  /**
   * @returns what a restart would interrupt, as full explanations; empty when nothing observable is running.
   * A guard that cannot establish the work returns a blocker rather than an empty list.
   */
  blockers(): readonly string[] | Promise<readonly string[]>
}

/** The host, view, work check, and diagnostic sink one guarded host operation uses. */
export interface GuardedHostOptions {
  /** Host to restart. */
  readonly dsh: DshHost
  /** View to repaint after the restart. */
  readonly view: DshChatView
  /** Observed running work the restart must not interrupt. */
  readonly guard: RestartGuard
  /** Diagnostic sink. */
  readonly log: (line: string) => void
}

/** The extension surfaces one workspace folder change needs. */
export interface WorkspaceWatchOptions extends GuardedHostOptions {
  /** Repaint host chrome that names the bound and pending workspace. */
  readonly repaint?: () => void
}

/** One guarded restart and the messages it reports. */
interface RestartRequest extends GuardedHostOptions {
  /** Message naming the running work that blocks the restart. */
  readonly refusal: (work: string) => string
  /** Message naming why the restart failed. */
  readonly failure: (reason: string) => string
  /** Message shown after the host and the repaint settle. */
  readonly success: string
  /** Readiness check after the repaint; throwing reports a failed operation instead of success. */
  readonly verify?: () => void
}

/**
 * Track the application work a restart must not interrupt.
 *
 * In-process the live context supplies running Agents, running terminals, and manager operations. A companion keeps
 * those inside its own process, so the monitor asks it through {@link RestartActivityMonitor} instead of assuming it
 * is idle: an unanswered query is reported as unverifiable work that blocks a destructive restart, never as "no work".
 */
export class RestartActivityMonitor implements RestartGuard {
  private readonly packageOperations = new Set<string>()
  private watched: RestartWorkContext | undefined
  private unwatch: (() => void) | undefined

  /**
   * @param context - the live application context, undefined while a companion owns it.
   * @param terminals - the VS Code terminals open in this window.
   * @param companionActivity - asks the companion for its running work; absent in a test double.
   */
  constructor(
    private readonly context: () => RestartWorkContext | undefined,
    private readonly terminals: () => readonly { readonly name: string }[],
    private readonly companionActivity: () => Promise<RestartActivity | undefined> = async () => undefined,
  ) {}

  /** Follow the current context's manager operations, replacing the watch after a restart. */
  watch(): void {
    const context = this.context()
    if (context === this.watched) return
    this.unwatch?.()
    this.unwatch = undefined
    this.watched = context
    this.packageOperations.clear()
    if (context === undefined) return
    this.unwatch = context.on('plugin-manager/operation', (operation) => {
      if (operation.phase === 'started') this.packageOperations.add(operation.id)
      else this.packageOperations.delete(operation.id)
    })
  }

  /**
   * @returns the observed activity, or undefined when the query could not establish it.
   * @throws when the companion query rejects; callers treat the failure as unknown work.
   */
  async activity(): Promise<RestartActivity | undefined> {
    this.watch()
    const integratedTerminals = this.terminals().filter(terminal => terminal.name === 'DSH').length
    const context = this.watched
    if (context === undefined) {
      const reported = await this.companionActivity()
      if (reported === undefined) return undefined
      // The companion counts its own terminals; the integrated DSH terminal this window created is separate.
      return { ...reported, runningTerminals: reported.runningTerminals + integratedTerminals }
    }
    const agents = context.get('agents') as { list(): readonly RestartAgent[] } | undefined
    const terminals = context.get('terminals') as { list(agent: RestartAgent): readonly RestartTerminal[] } | undefined
    const live = agents?.list() ?? []
    let runningTerminals = integratedTerminals
    if (terminals !== undefined) {
      for (const agent of live) runningTerminals += terminals.list(agent).filter(item => item.status.kind === 'running').length
    }
    return {
      runningTurns: live.filter(agent => agent.status === 'running').length,
      packageOperations: this.packageOperations.size,
      runningTerminals,
    }
  }

  /** @returns what a restart would interrupt, as full explanations. */
  async blockers(): Promise<readonly string[]> {
    let activity: RestartActivity | undefined
    try {
      activity = await this.activity()
    } catch (error) {
      // The companion did not answer, so the work is unknown rather than absent.
      return [`a turn or package operation this window cannot query (${describe(error)})`]
    }
    if (activity === undefined) return ['a turn or package operation this window cannot query']
    const blocked: string[] = []
    if (activity.runningTurns > 0) blocked.push('a running turn')
    if (activity.packageOperations > 0) blocked.push('a running package operation')
    if (activity.runningTerminals > 0) blocked.push('a running DSH terminal command')
    return blocked
  }

  /** Release the manager-operation subscription. */
  dispose(): void {
    this.unwatch?.()
    this.unwatch = undefined
    this.watched = undefined
  }
}

/** @param context - the live host context. @returns the work-check view of it. */
function restartWorkContext(context: unknown): RestartWorkContext | undefined {
  return context as RestartWorkContext | undefined
}

/**
 * Follow VS Code workspace folder changes and report each change that needs an
 * explicit rebind.
 * @param options - host, work check, view, and sink for the report.
 * @returns the subscription to dispose with the extension.
 */
export function watchWorkspaceFolders(options: WorkspaceWatchOptions): vscode.Disposable {
  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    options.repaint?.()
    void reportWorkspaceChange(options).catch((error: unknown) => {
      options.log(`dsh: workspace folder change could not be reported: ${describe(error)}`)
    })
  })
}

/**
 * Report one workspace folder change against the host's binding.
 *
 * A change that leaves the first root alone is logged only. A changed or
 * refused first root produces an explicit notice that names both folders; the
 * notice offers the guarded restart, and running work is never interrupted on
 * its own. A closed bound root names the recovery path instead.
 * @param options - host, work check, view, and sink for the report.
 */
export async function reportWorkspaceChange(options: WorkspaceWatchOptions): Promise<void> {
  const change = options.dsh.observeWorkspaceFolders()
  const log = options.log
  const showLog = vscode.l10n.t('Show Log')
  const showLogFor = async (choice: string | undefined): Promise<void> => {
    if (choice === showLog) await vscode.commands.executeCommand('dsh.showLog')
  }

  if (change.refusal !== undefined) {
    log(change.refusal)
    const message = change.bound === undefined
      ? vscode.l10n.t('DSH cannot use the first workspace folder: {reason}', { reason: change.refusal })
      : vscode.l10n.t(
        'DSH keeps using {workspace} because the first workspace folder cannot be used: {reason}',
        { workspace: change.bound, reason: change.refusal },
      )
    await showLogFor(await vscode.window.showWarningMessage(message, showLog))
    return
  }
  if (change.bound === undefined) {
    if (change.current === undefined) return
    log(`dsh: no workspace is bound yet; ${change.current} is open`)
    const message = vscode.l10n.t(
      'DSH has no bound workspace folder. The first open folder is {current}; run DSH: Restart Host to bind it.',
      { current: change.current },
    )
    await showLogFor(await vscode.window.showWarningMessage(message, showLog))
    return
  }
  if (!change.changed) {
    log(`dsh: the workspace folders changed; DSH keeps using ${change.bound}`)
    return
  }
  if (change.current === undefined) {
    log(`dsh: no local workspace folder is open; DSH keeps using ${change.bound} and refuses work that needs it`)
    const message = vscode.l10n.t(
      'DSH keeps using {workspace}. No local workspace folder is open, so work that needs it is refused; open a local folder and run DSH: Restart Host to bind it.',
      { workspace: change.bound },
    )
    await showLogFor(await vscode.window.showWarningMessage(message, showLog))
    return
  }
  const blockers = await options.guard.blockers()
  const restartLabel = vscode.l10n.t('Restart DSH')
  const message = blockers.length > 0
    ? vscode.l10n.t(
      'DSH is still using {workspace}. The first open folder is now {current}; {work} is running, so stop it before running DSH: Restart Host to bind the new folder.',
      { workspace: change.bound, current: change.current, work: blockers.join(', ') },
    )
    : vscode.l10n.t(
      'DSH is still using {workspace}. The first open folder is now {current}; DSH: Restart Host binds it and stops any running turn.',
      { workspace: change.bound, current: change.current },
    )
  log(`dsh: the first workspace folder changed from ${change.bound} to ${change.current}`)
  const actions = blockers.length > 0 ? [showLog] : [restartLabel, showLog]
  const choice = await vscode.window.showWarningMessage(message, ...actions)
  if (blockers.length === 0 && choice === restartLabel) {
    await switchWorkspace(options)
    return
  }
  await showLogFor(choice)
}

/**
 * Make the bound workspace root and the first-root-only policy visible.
 * @param change - workspace comparison taken after start.
 * @param log - diagnostic sink.
 */
export function reportWorkspaceBinding(change: WorkspaceChange, log: (line: string) => void): void {
  const root = change.bound ?? change.current
  if (root === undefined) return
  log(`dsh: workspace root ${root}`)
  if (change.folders <= 1) return
  log(`dsh: ${String(change.folders)} workspace folders are open; only the first root (${root}) is bound`)
  void vscode.window.showInformationMessage(vscode.l10n.t(
    'DSH uses only the first workspace folder: {root}. Other folders in this window are not passed to DSH; a restart binds the first folder open at that time.',
    { root },
  ))
}

/**
 * Bind the first open folder through the existing guarded restart.
 * @param options - host, work check, view, and sink for the switch.
 * @throws when no local folder can be bound, running work blocks the restart, or the launch did not bind the folder.
 */
export async function switchWorkspace(options: WorkspaceWatchOptions): Promise<void> {
  const change = options.dsh.observeWorkspaceFolders()
  const target = change.current
  const previous = change.bound
  if (target === undefined) {
    const detail = change.refusal ?? vscode.l10n.t('no local folder is open')
    const reason = vscode.l10n.t('DSH cannot switch the workspace: {detail}', { detail })
    options.log(change.refusal ?? 'dsh: workspace switch refused: no local folder is open')
    void vscode.window.showErrorMessage(reason)
    throw new Error(reason)
  }
  if (target === previous) {
    void vscode.window.showInformationMessage(vscode.l10n.t('DSH already uses {workspace}.', { workspace: target }))
    return
  }
  await guardedRestart({
    ...options,
    refusal: work => vscode.l10n.t(
      'DSH cannot switch the workspace while {work} is running. Stop it and try again.',
      { work },
    ),
    failure: reason => vscode.l10n.t(
      'DSH could not switch to {workspace}: {reason} The previous workspace {previous} is kept and DSH reports failed; DSH: Restart Host retries.',
      { workspace: target, previous: previous ?? vscode.l10n.t('none'), reason },
    ),
    success: vscode.l10n.t('DSH now uses {workspace}.', { workspace: target }),
    verify: () => {
      if (options.dsh.snapshot().state === 'ready' && options.dsh.workspaceBinding === target) return
      const snapshot = options.dsh.snapshot()
      const reason = vscode.l10n.t(
        'DSH did not bind {workspace}; the workspace binding is {bound} and DSH reports {state}. Run DSH: Restart Host to try again.',
        { workspace: target, bound: options.dsh.workspaceBinding ?? vscode.l10n.t('none'), state: snapshot.state },
      )
      options.log(`dsh: ${reason}`)
      void vscode.window.showErrorMessage(reason)
      throw new Error(reason)
    },
  })
}

/**
 * Run one guarded restart: refuse observed work, stop and start the host,
 * repaint the view, then confirm.
 * @param request - operation, messages, and the optional readiness check.
 * @throws when the guard refuses, the host restart fails, or the repaint or readiness check fails.
 */
async function guardedRestart(request: RestartRequest): Promise<void> {
  const { dsh, view, guard, log } = request
  log('dsh: restarting')
  const blockers = await guard.blockers()
  if (blockers.length > 0) {
    const reason = request.refusal(blockers.join(', '))
    log(`dsh: restart refused: ${blockers.join(', ')}`)
    void vscode.window.showErrorMessage(reason)
    throw new Error(reason)
  }
  try {
    // Nothing new may start after the confirmation and before the stop: closing the page's transport first turns a
    // late submission into its own closed-transport error instead of work the restart interrupts.
    await view.freezeTransport('DSH is restarting')
    await dsh.restart()
  } catch (error) {
    log(`dsh: restart failed: ${describe(error)}`)
    void vscode.window.showErrorMessage(request.failure(messageOf(error)))
    // The page's transport stays closed until it is repainted, so restore a live one before reporting the failure.
    try {
      await view.refresh()
    } catch (refreshError) {
      log(`dsh: the chat view could not be restored after the failed restart: ${describe(refreshError)}`)
    }
    throw error
  }
  try {
    await view.refresh()
  } catch (error) {
    const reason = `DSH restarted, but the chat view could not be refreshed: ${messageOf(error)}`
    log(`dsh: ${reason}`)
    void vscode.window.showErrorMessage(reason)
    throw new Error(reason)
  }
  request.verify?.()
  if (dsh.configMismatch) {
    const mismatch = vscode.l10n.t('The shared Host started from another window with different settings or a different extension version. Reload any older windows and retry from this window when DSH is idle.')
    log(`dsh: ${mismatch}`)
    void vscode.window.showErrorMessage(request.failure(mismatch))
    throw new Error(mismatch)
  }
  void vscode.window.showInformationMessage(request.success)
}

/**
 * The restart notice for saved provider settings the running host has not read.
 * @param changed - `dsh.<name>` launch settings whose saved value differs from the running host.
 * @returns the warning text offering the explicit restart.
 */
export function restartNoticeText(changed: readonly string[]): string {
  return vscode.l10n.t(
    'DSH: saved settings differ from the running host ({settings}). Restart DSH after running work finishes to apply them.',
    { settings: changed.join(', ') },
  )
}

/**
 * Write the company route's deployment settings so the running configuration reads them.
 *
 * The generated launch overlay reads `dsh.providerMode` and `dsh.llmBaseUrl` on
 * the next launch, so a running host keeps its former values until the guarded
 * restart. Each value goes to the layer that decides it: a workspace override
 * would hide a global write, and a workspace-folder override is refused with an
 * instruction instead of reporting a save the runtime would ignore.
 * @param baseUrl - validated Chat Completions root.
 * @throws when VS Code refuses either update, a folder override owns a value, or
 * the written value is not what the setting reads back.
 */
export async function writeCompanySettings(baseUrl: string): Promise<void> {
  // The endpoint lands before the mode switch: a failure between the two writes
  // then leaves the previous provider mode in place instead of selecting a
  // company route with no endpoint.
  await writeEffectiveSetting('llmBaseUrl', baseUrl)
  try {
    await writeEffectiveSetting('providerMode', 'openai-compatible')
  } catch (error) {
    throw new Error(`dsh.llmBaseUrl was saved, but the provider mode was not: ${messageOf(error)}`)
  }
}

/** The company first-run setup as the command collected it. */
export interface CompanySetupRequest extends GuardedHostOptions {
  /** Current `dsh.llmBaseUrl`, prefilled into the endpoint prompt. */
  readonly baseUrl: string
  /** Ask for the endpoint URL; undefined cancels the command. */
  readonly askBaseUrl: (value: string) => PromiseLike<string | undefined>
  /** Ask for the optional key; undefined cancels. */
  readonly askApiKey: (changedEndpoint: boolean) => PromiseLike<string | undefined>
  /** Store the trimmed key for the destination endpoint, or clear its key when empty. */
  readonly writeKey: (baseUrl: string, apiKey: string) => Promise<void>
}

/**
 * Collect the company endpoint, store the optional key only in SecretStorage,
 * write the deployment settings, and start the new configuration through the
 * guarded restart.
 *
 * No model is asked for: the launch overlay pins the unconfigured placeholder
 * so the application boots and the Models page can discover the endpoint's real
 * model. Failure reports separate what was saved from what is active, and the
 * key is never logged or written anywhere outside SecretStorage.
 * An incomplete write stops the command before restart. The new URL is saved only after its key and model selection are ready.
 * @param request - prompt callbacks, destination key write, and guarded restart inputs.
 * @throws when the guarded restart refuses or fails.
 */
export async function configureCompanyEndpoint(request: CompanySetupRequest): Promise<void> {
  const entered = await request.askBaseUrl(request.baseUrl)
  if (entered === undefined) return
  const refusal = companyBaseUrlError(entered)
  if (refusal !== undefined) {
    request.log(`dsh: company endpoint refused: ${refusal}`)
    void vscode.window.showErrorMessage(
      vscode.l10n.t('DSH cannot use that company endpoint: {reason}', { reason: refusal }),
    )
    return
  }
  const baseUrl = entered.trim()
  const changedEndpoint = companyKeySlot(request.baseUrl) !== companyKeySlot(baseUrl)
  const key = await request.askApiKey(changedEndpoint)
  if (key === undefined) return
  try {
    effectiveSettingWrite('llmBaseUrl')
    effectiveSettingWrite('providerMode')
    if (changedEndpoint) effectiveSettingWrite('llmModel')
  } catch (error) {
    const reason = messageOf(error)
    request.log(`dsh: company endpoint settings could not be saved: ${reason}`)
    void vscode.window.showErrorMessage(
      vscode.l10n.t('DSH could not save the company endpoint settings: {reason}', { reason }),
    )
    return
  }
  const apiKey = key.trim()
  if (changedEndpoint || apiKey !== '') {
    try {
      await request.writeKey(baseUrl, apiKey)
      request.log(apiKey === '' ? 'dsh: destination company endpoint key cleared' : 'dsh: company endpoint key stored in SecretStorage')
    } catch (error) {
      request.log(`dsh: company endpoint credential update failed (${error instanceof Error ? error.name : 'unknown error'})`)
      void vscode.window.showErrorMessage(vscode.l10n.t(
        'DSH could not update the company endpoint key in VS Code SecretStorage. The endpoint settings were not changed. Run Configure Company Endpoint to retry.',
      ))
      return
    }
  }
  try {
    if (changedEndpoint) await writeEffectiveSetting('llmModel', '')
    await writeCompanySettings(baseUrl)
  } catch (error) {
    const reason = messageOf(error)
    request.log(`dsh: company endpoint settings could not be saved: ${reason}`)
    void vscode.window.showErrorMessage(vscode.l10n.t(
      'DSH could not complete the company endpoint setup: {reason}. Review the saved settings and run Configure Company Endpoint again.',
      { reason },
    ))
    return
  }
  request.log('dsh: company endpoint settings saved')
  // The model is read after the settings writes so the message names what the
  // running host will have: a saved model, or the unconfigured placeholder.
  const savedModel = request.dsh.providerSettings.model.trim()
  const success = changedEndpoint || savedModel === ''
    ? vscode.l10n.t(
      'DSH restarted with the company endpoint. No model is selected for it yet; open Models, fetch the available models, and choose one.',
    )
    : vscode.l10n.t('DSH restarted with the company endpoint and {model}.', { model: savedModel })
  await guardedRestart({
    dsh: request.dsh,
    view: request.view,
    guard: request.guard,
    log: request.log,
    refusal: work => vscode.l10n.t(
      'DSH: the company endpoint settings were saved, but DSH cannot restart while {work} is running; stop it and run DSH: Restart Host to start the new configuration.',
      { work },
    ),
    failure: reason => vscode.l10n.t(
      'DSH: the company endpoint settings were saved, but the new configuration did not start: {reason}. Run DSH: Restart Host to try again.',
      { reason },
    ),
    success,
  })
}

/**
 * Activate: start DSH and register the chat view.
 * @param context - the extension context.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DSH')
  context.subscriptions.push(output)
  const log = (line: string): void => {
    output.appendLine(line)
    // Mirrored so the extension-host log captures boot diagnostics off-screen.
    console.log(line)
  }
  log(`dsh: activating (extension host Node ${process.version}, ${process.platform}/${process.arch})`)

  const readCredentials = async (companyUrl: string): Promise<LaunchCredentials> => {
    const apiKey = await context.secrets.get(API_KEY_SECRET)
    const llmApiKey = await context.secrets.get(companyKeySlot(companyUrl))
    const baseUrl = vscode.workspace.getConfiguration('dsh').get<string>('apiBaseUrl')
    return {
      ...apiKey === undefined ? {} : { apiKey },
      ...llmApiKey === undefined ? {} : { llmApiKey },
      ...baseUrl === undefined || baseUrl === '' ? {} : { baseUrl },
    }
  }
  const dsh = new DshHost(context, log, readCredentials)
  host = dsh
  const restartGuard = new RestartActivityMonitor(
    () => restartWorkContext(dsh.context),
    () => vscode.window.terminals,
    async () => await dsh.companionActivity(),
  )
  context.subscriptions.push({ dispose: () => { restartGuard.dispose() } })
  // The provider settings the running companion launched with. Saved changes
  // reach the application only on the next launch.
  let launchedProvider: ProviderSettings | undefined
  context.subscriptions.push({ dispose: dsh.onChange(() => {
    restartGuard.watch()
    const state = dsh.snapshot().state
    if (state === 'ready') launchedProvider = dsh.providerSettings
    // A stopped host reads the saved settings on its next launch, so a saved
    // change needs no restart notice.
    else if (state === 'stopped') launchedProvider = undefined
  }) })
  let restartNoticeShown = false
  // The setup command owns its restart and reports saved-versus-active itself,
  // so the settings-change notice must not prompt a second restart mid-command.
  let companySetupRunning = false
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!companySetupRunning && event.affectsConfiguration('dsh')) view.refreshModelStatus()
    if (
      companySetupRunning || launchedProvider === undefined || restartNoticeShown || !event.affectsConfiguration('dsh')
    ) return
    const changed = changedProviderSettings(launchedProvider, dsh.providerSettings)
    if (changed.length === 0) return
    restartNoticeShown = true
    log(`dsh: saved provider settings differ from the running host: ${changed.join(', ')}`)
    // Restarting stays an explicit user action: a settings change never stops a
    // running turn on its own.
    void (async () => {
      try {
        const choice = await vscode.window.showWarningMessage(
          restartNoticeText(changed),
          vscode.l10n.t('Restart DSH'),
        )
        if (choice !== undefined) await vscode.commands.executeCommand('dsh.restart')
      } catch (error) {
        log(`dsh: restart after saved provider settings changed failed: ${describe(error)}`)
      } finally {
        restartNoticeShown = false
      }
    })()
  }))
  /**
   * Surface an incomplete company route instead of letting the public DeepSeek
   * provider stand in for it. The same launch overlay pins the company model,
   * so this check covers the deployment fields the extension owns.
   */
  const reportCompanySetup = async (): Promise<void> => {
    const settings = dsh.providerSettings
    if (settings.mode !== 'openai-compatible') return
    const status = companySetupStatus(settings, await readCredentials(settings.baseUrl))
    if (status.complete) {
      if (status.credential === 'not-stored') {
        // The key is optional: the endpoint may accept unauthenticated calls, and
        // whether it requires one is only knowable from its own answer.
        log('dsh: no private endpoint key is stored in SecretStorage; whether the endpoint requires one was not checked')
      }
      return
    }
    const fieldName = (field: CompanySetupField): string => field === 'endpoint'
      ? 'dsh.llmBaseUrl'
      : field === 'model' ? 'dsh.llmModel' : 'the private endpoint key in VS Code SecretStorage'
    const missing = status.missing.map(fieldName).join(', ')
    log(`dsh: company route settings incomplete; missing ${missing}; managed credentials, environment values, and .env files are not checked`)
    const openSettings = vscode.l10n.t('Open Settings')
    const configure = vscode.l10n.t('Configure Company Endpoint')
    const setKey = vscode.l10n.t('Set Private Endpoint API Key')
    const showLog = vscode.l10n.t('Show Log')
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'DSH: the company model route settings this extension can check are incomplete (missing {fields}) and DSH does not fall back to the public DeepSeek provider. Managed credentials, environment values, and .env files are not checked.',
        { fields: missing },
      ),
      configure,
      openSettings,
      setKey,
      showLog,
    )
    if (choice === configure) await vscode.commands.executeCommand('dsh.configureCompany')
    else if (choice === openSettings) await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.llm')
    else if (choice === setKey) await vscode.commands.executeCommand('dsh.setLlmKey')
    else if (choice === showLog) await vscode.commands.executeCommand('dsh.showLog')
  }
  // The update flow's user-facing copy is Chinese: its operator guide (docs/vscode/INTRANET_UPDATE.md) and its two
  // required action labels are Chinese. Every string stays an l10n key.
  const installAndReloadLabel = vscode.l10n.t('安装并重载')
  const laterLabel = vscode.l10n.t('稍后')
  const cancelLabel = vscode.l10n.t('取消')
  const updateStatus = vscode.window.createStatusBarItem('dsh.update.available', vscode.StatusBarAlignment.Left, 99)
  updateStatus.name = vscode.l10n.t('DSH 更新')
  updateStatus.command = 'dsh.checkForUpdates'
  context.subscriptions.push(updateStatus)
  /** Run one download behind a cancellable progress notification. */
  const downloadWithProgress = async (
    run: (signal: AbortSignal) => Promise<DownloadResult>,
  ): Promise<DownloadResult> => {
    const cancellation = new AbortController()
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('正在下载 DSH 更新'),
        cancellable: true,
      },
      async (_progress, token) => {
        const requested = token.onCancellationRequested(() => { cancellation.abort() })
        try {
          return await run(cancellation.signal)
        } finally {
          requested.dispose()
        }
      },
    )
  }
  const updates = new UpdateController({
    extensionId: context.extension.id,
    localVersion: String(context.extension.packageJSON.version ?? ''),
    vscodeVersion: vscode.version,
    directory: vscode.Uri.joinPath(context.globalStorageUri, 'updates').fsPath,
    feedUrl: () => vscode.workspace.getConfiguration('dsh').get<string>('update.feedUrl') ?? '',
    checkIntervalMinutes: () => vscode.workspace.getConfiguration('dsh').get<number>('update.checkIntervalMinutes') ?? 0,
    onStateChange: state => {
      if (state.name === 'checking') return
      if (state.name !== 'available' && state.name !== 'staged') {
        updateStatus.hide()
        return
      }
      updateStatus.text = `$(cloud-download) ${vscode.l10n.t('DSH {version} 可更新', { version: state.version })}`
      updateStatus.tooltip = vscode.l10n.t('查看 DSH 更新并选择是否下载和安装')
      updateStatus.show()
    },
    download: downloadWithProgress,
    install: async staged => await installStagedUpdate({
      path: staged.path,
      version: staged.version,
      guard: restartGuard,
      // The installed VSIX replaces the directory the detached shared host was
      // launched from; stopping it here is what makes the post-reload window
      // boot the new version instead of attaching to the removed one.
      handover: async () => { await dsh.stopHost() },
      confirm: async (request) => {
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'DSH {version} 已下载并通过校验，但 {work} 正在运行，安装并重载窗口会中断它。现在安装吗？',
            { version: request.version, work: request.work.join(', ') },
          ),
          installAndReloadLabel,
          cancelLabel,
        )
        return choice === installAndReloadLabel
      },
      log,
    }),
    log,
  })
  /** Apply the verified file, downloading it first when only a feed result is available. */
  const applyUpdate = async (): Promise<void> => {
    const outcome = await updates.installAndReload()
    switch (outcome.status) {
      case 'installed':
        if (outcome.reloaded) return
        void vscode.window.showWarningMessage(vscode.l10n.t(
          'DSH {version} 已安装，但未能自动切换到新版本：{reason}',
          { version: outcome.version, reason: outcome.detail ?? '' },
        ))
        return
      case 'cancelled':
        log(`dsh: ${outcome.reason}`)
        void vscode.window.showInformationMessage(vscode.l10n.t('已取消 DSH 更新。'))
        return
      case 'deferred':
        log(`dsh: ${outcome.reason}`)
        void vscode.window.showInformationMessage(vscode.l10n.t(
          'DSH 更新已下载并通过校验，但当前有任务在运行。等任务结束后再次运行 DSH: Install Update 即可安装，无需重新下载。',
        ))
        return
      case 'busy':
        void vscode.window.showInformationMessage(vscode.l10n.t('DSH 正在处理更新：{reason}', { reason: outcome.reason }))
        return
      case 'nothing-to-install':
        void vscode.window.showInformationMessage(
          vscode.l10n.t('没有可安装的 DSH 更新：{reason}', { reason: outcome.reason }),
        )
        return
      case 'failed':
        log(`dsh: update install failed: ${outcome.reason}`)
        void vscode.window.showErrorMessage(vscode.l10n.t('DSH 更新安装失败：{reason}', { reason: outcome.reason }))
        return
    }
  }
  /** Report a check outcome that has no applicable update, through the log and one message. */
  const reportCheck = (outcome: UpdateCheckOutcome): void => {
    switch (outcome.status) {
      case 'skipped':
        void vscode.window.showInformationMessage(
          vscode.l10n.t('DSH 更新检查未执行：{reason}', { reason: outcome.reason }),
        )
        return
      case 'busy':
        void vscode.window.showInformationMessage(vscode.l10n.t('DSH 正在处理更新：{reason}', { reason: outcome.reason }))
        return
      case 'current':
        void vscode.window.showInformationMessage(
          vscode.l10n.t('DSH 已是最新版本（{detail}）。', { detail: outcome.detail }),
        )
        return
      case 'ineligible':
        log(`dsh: update check found no applicable update: ${outcome.reason}`)
        void vscode.window.showWarningMessage(
          vscode.l10n.t('内网更新源中的版本不适用于当前窗口：{reason}', { reason: outcome.reason }),
        )
        return
      case 'failed':
        log(`dsh: update check failed: ${outcome.reason}`)
        void vscode.window.showErrorMessage(vscode.l10n.t('DSH 更新检查失败：{reason}', { reason: outcome.reason }))
        return
      case 'available':
      case 'staged':
        return
    }
  }
  const diffs = new DiffDocuments()
  diffs.register(context.subscriptions)
  context.subscriptions.push({ dispose: () => { diffs.dispose() } })
  const view = new DshChatView(context.extensionUri, dsh, log, diffs)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.name = 'DSH'
  status.command = 'dsh.open'
  const paintStatus = (): void => {
    const snapshot = dsh.snapshot()
    status.text = snapshot.state === 'failed' ? '$(warning) DSH' : '$(comment-discussion) DSH'
    const workspace = dsh.observeWorkspaceFolders()
    const binding = workspace.bound
    const bound = binding === undefined
      ? 'no workspace bound'
      : workspace.removed ? `workspace ${binding} (no longer open)` : `workspace ${binding}`
    const policy = workspace.folders > 1 ? `; first of ${String(workspace.folders)} folders only` : ''
    const pending = binding !== undefined && workspace.changed
      ? workspace.current === undefined
        ? '; no local folder is open for a restart to bind'
        : `; ${workspace.current} awaits a restart`
      : ''
    status.tooltip = `DSH: ${snapshot.state} (${snapshot.mode}); ${bound}${policy}${pending}`
  }
  paintStatus()
  status.show()
  context.subscriptions.push(status, { dispose: dsh.onChange(paintStatus) })
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.chat', view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.open', async () => {
      await vscode.commands.executeCommand('dsh.chat.focus')
    }),
    vscode.commands.registerCommand('dsh.newSession', () => { view.command('session.new') }),
    vscode.commands.registerCommand('dsh.searchSessions', () => { view.command('session.search') }),
    vscode.commands.registerCommand('dsh.forkSession', () => { view.command('session.fork') }),
    vscode.commands.registerCommand('dsh.restart', async () => {
      await restart(dsh, view, restartGuard, log, 'DSH restarted')
    }),
    vscode.commands.registerCommand('dsh.checkForUpdates', async () => {
      const outcome = await updates.check('manual')
      if (outcome.status === 'available') {
        const notes = outcome.update.manifest.releaseNotes?.trim() ?? ''
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t('DSH 有新版本 {version}（当前 {current}）。来源：{source}{notes}', {
            version: outcome.update.version,
            current: outcome.update.localVersion,
            source: outcome.update.manifest.url,
            notes: notes === '' ? '' : vscode.l10n.t('。说明：{notes}', { notes }),
          }),
          installAndReloadLabel,
          laterLabel,
        )
        if (choice === installAndReloadLabel) await applyUpdate()
        return
      }
      if (outcome.status === 'staged') {
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t('DSH {version} 已下载并通过校验。', { version: outcome.staged.version }),
          installAndReloadLabel,
          laterLabel,
        )
        if (choice === installAndReloadLabel) await applyUpdate()
        return
      }
      reportCheck(outcome)
    }),
    vscode.commands.registerCommand('dsh.installUpdate', async () => {
      const outcome = await updates.check('manual')
      if (outcome.status === 'available' || outcome.status === 'staged') {
        await applyUpdate()
        return
      }
      reportCheck(outcome)
    }),
    vscode.commands.registerCommand('dsh.configureCompany', async () => {
      if (companySetupRunning) return
      companySetupRunning = true
      try {
        await configureCompanyEndpoint({
          dsh, view, guard: restartGuard, log,
          baseUrl: vscode.workspace.getConfiguration('dsh').get<string>('llmBaseUrl') ?? '',
          askBaseUrl: value => vscode.window.showInputBox({
            prompt: vscode.l10n.t('Company Chat Completions base URL, for example http://llm.lan:8000/v1'),
            value,
            ignoreFocusOut: true,
          }),
          askApiKey: changedEndpoint => vscode.window.showInputBox({
            prompt: changedEndpoint
              ? vscode.l10n.t('API key for the new company endpoint. Leave blank to clear its stored key.')
              : vscode.l10n.t('Company endpoint API key. Leave blank to keep its stored key.'),
            password: true,
            ignoreFocusOut: true,
          }),
          writeKey: async (baseUrl, apiKey) => {
            const slot = companyKeySlot(baseUrl)
            if (apiKey === '') await context.secrets.delete(slot)
            else await context.secrets.store(slot, apiKey)
          },
        })
      } finally {
        companySetupRunning = false
      }
    }),
    vscode.commands.registerCommand('dsh.selectModel', async () => {
      if (companySetupRunning) return
      const baseUrl = (vscode.workspace.getConfiguration('dsh').get<string>('llmBaseUrl') ?? '').trim()
      if (baseUrl === '') {
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t('Configure the company endpoint before selecting a model.'),
          vscode.l10n.t('Configure company endpoint'),
        )
        if (choice !== undefined) await vscode.commands.executeCommand('dsh.configureCompany')
        return
      }
      companySetupRunning = true
      try {
        const outcome = await selectCompanyModel({
          baseUrl,
          readKey: async () => await context.secrets.get(companyKeySlot(baseUrl)),
          listModels: (root, apiKey) => fetchCompanyModels(root, apiKey, globalThis.fetch),
          currentModel: (vscode.workspace.getConfiguration('dsh').get<string>('llmModel') ?? '').trim(),
          pickModel: async (models, current) => {
            const picked = await vscode.window.showQuickPick(
              models.map(model => ({
                label: model,
                ...(model === current ? { description: vscode.l10n.t('current') } : {}),
              })),
              { placeHolder: vscode.l10n.t('Model served by {endpoint}', { endpoint: baseUrl }), ignoreFocusOut: true },
            )
            return picked?.label
          },
          saveModel: async (model) => {
            if (companyKeySlot(dsh.providerSettings.baseUrl) !== companyKeySlot(baseUrl)) {
              throw new Error(vscode.l10n.t('The company endpoint changed while selecting a model. Fetch its model list again.'))
            }
            await writeEffectiveSetting('llmModel', model)
          },
          confirmRestart: async (model) => {
            const choice = await vscode.window.showInformationMessage(
              vscode.l10n.t('DSH will use {model} after it restarts.', { model }),
              vscode.l10n.t('Restart DSH'),
            )
            if (choice === undefined) return false
            await vscode.commands.executeCommand('dsh.restart')
            return true
          },
          log,
        })
        if (outcome.status === 'failed') void vscode.window.showErrorMessage(outcome.diagnostic)
        else view.refreshModelStatus()
      } finally {
        companySetupRunning = false
      }
    }),
    vscode.commands.registerCommand('dsh.showLog', async () => { output.show(true) }),
    vscode.commands.registerCommand('dsh.diagnostics', async () => {
      const report = formatDiagnostics(await dsh.diagnostics())
      for (const line of report) log(`dsh: ${line}`)
      output.show(true)
      void vscode.window.showInformationMessage('DSH diagnostics written to the DSH output channel')
    }),
    vscode.commands.registerCommand('dsh.runInTerminal', async () => {
      const command = await vscode.window.showInputBox({ prompt: 'Command to run in the DSH terminal', ignoreFocusOut: true })
      if (command === undefined || command.trim() === '') return
      let cwd: string
      try {
        cwd = dsh.cwd
      } catch (error) {
        const reason = messageOf(error)
        log(`dsh: terminal command refused: ${reason}`)
        void vscode.window.showErrorMessage(reason)
        return
      }
      const result = await runInTerminal(command.trim(), cwd)
      log(result.ok
        ? `dsh: terminal exit=${String(result.run.exitCode)} output=${result.run.output.trim().slice(0, 400)}`
        : `dsh: terminal failed: ${result.error}`)
    }),
    vscode.commands.registerCommand('dsh.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'DeepSeek API key (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      })
      if (value === undefined || value.trim() === '') return
      await restartAfterCredentialChange({
        dsh, view, guard: restartGuard, log,
        subject: 'API key',
        action: 'stored',
        write: () => context.secrets.store(API_KEY_SECRET, value.trim()),
        saved: 'dsh: API key stored in SecretStorage',
        success: 'DSH restarted with the stored API key',
      })
    }),
    vscode.commands.registerCommand('dsh.setLlmKey', async () => {
      const baseUrl = dsh.providerSettings.baseUrl
      if (companyBaseUrlError(baseUrl) !== undefined) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Configure a valid company endpoint before storing its key.'))
        return
      }
      const value = await vscode.window.showInputBox({
        prompt: 'Private endpoint API key (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      })
      if (value === undefined || value.trim() === '') return
      await restartAfterCredentialChange({
        dsh, view, guard: restartGuard, log,
        subject: 'private endpoint key',
        action: 'stored',
        write: () => context.secrets.store(companyKeySlot(baseUrl), value.trim()),
        saved: 'dsh: private endpoint key stored in SecretStorage',
        success: 'DSH restarted with the private endpoint key',
      })
    }),
    vscode.commands.registerCommand('dsh.clearLlmKey', async () => {
      const baseUrl = dsh.providerSettings.baseUrl
      if (companyBaseUrlError(baseUrl) !== undefined) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Configure a valid company endpoint before clearing its key.'))
        return
      }
      await restartAfterCredentialChange({
        dsh, view, guard: restartGuard, log,
        subject: 'private endpoint key',
        action: 'removed',
        write: () => context.secrets.delete(companyKeySlot(baseUrl)),
        saved: 'dsh: private endpoint key cleared from SecretStorage',
        success: clearedCredentialNotice('private endpoint key'),
      })
    }),
    vscode.commands.registerCommand('dsh.clearApiKey', async () => {
      await restartAfterCredentialChange({
        dsh, view, guard: restartGuard, log,
        subject: 'API key',
        action: 'removed',
        write: () => context.secrets.delete(API_KEY_SECRET),
        saved: 'dsh: API key cleared',
        success: clearedCredentialNotice('API key'),
      })
    }),
  )

  context.subscriptions.push(watchWorkspaceFolders({ dsh, guard: restartGuard, view, log, repaint: paintStatus }))
  // The automatic flow stays off until `dsh.update.feedUrl` names a feed and the interval is above 0; start() checks
  // the interval before it schedules anything and returns a no-op disposer otherwise.
  context.subscriptions.push({ dispose: updates.start() })

  try {
    await dsh.start()
    restartGuard.watch()
    reportWorkspaceBinding(dsh.observeWorkspaceFolders(), log)
    for (const line of formatDiagnostics(await dsh.diagnostics())) log(`dsh: ${line}`)
    await view.refresh()
    void reportCompanySetup().catch((error: unknown) => {
      log(`dsh: company setup check failed: ${describe(error)}`)
    })
    if (process.env.DSH_VSCODE_TERMINAL_SMOKE === '1') {
      const smoke = await runInTerminal('echo dsh-terminal-smoke', dsh.cwd)
      log(smoke.ok
        ? `dsh: terminal smoke exit=${String(smoke.run.exitCode)} output=${smoke.run.output.trim()}`
        : `dsh: terminal smoke failed: ${smoke.error}`)
    }
    if (process.env.DSH_VSCODE_OPEN_ON_START === '1') {
      await vscode.commands.executeCommand('workbench.view.extension.dsh')
    }
  } catch (error) {
    log(`dsh: activation boot failed: ${describe(error)}`)
    // An unconfigured company endpoint cannot generate its launch overlay, so
    // startup fails before the setup warning below can offer the command. The
    // failure itself must carry the first-run entry instead.
    const endpoint = dsh.providerSettings
    const unconfigured = endpoint.mode === 'openai-compatible' && companyBaseUrlError(endpoint.baseUrl) !== undefined
    const configure = vscode.l10n.t('Configure Company Endpoint')
    const choice = await vscode.window.showErrorMessage(
      unconfigured
        ? vscode.l10n.t(
          'DSH failed to start: {reason}. Configure the company endpoint to start DSH.',
          { reason: messageOf(error) },
        )
        : `DSH failed to start: ${messageOf(error)}`,
      ...unconfigured ? [configure] : [],
    )
    if (unconfigured && choice === configure) await vscode.commands.executeCommand('dsh.configureCompany')
  }
}

/** Deactivate: dispose the host so no process or fiber outlives the window. */
export async function deactivate(): Promise<void> {
  await host?.stop()
  host = undefined
}

/** @param error - thrown value. @returns its message line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Refuse work a restart cannot coordinate, restart the application, then repaint the view.
 * @param dsh - host to restart.
 * @param view - view to refresh.
 * @param guard - observed running work that makes the restart unsafe.
 * @param log - diagnostic sink.
 * @param message - confirmation shown when the restart succeeds.
 * @throws when running work cannot be stopped safely, the host reports a restart failure, or the view cannot repaint.
 */
export async function restart(
  dsh: DshHost,
  view: DshChatView,
  guard: RestartGuard,
  log: (line: string) => void,
  message: string,
): Promise<void> {
  await guardedRestart({
    dsh,
    view,
    guard,
    log,
    refusal: work => vscode.l10n.t('DSH cannot restart while {work} is running. Stop it and try again.', { work }),
    failure: reason => `DSH restart failed: ${reason}`,
    success: message,
  })
}

/** One SecretStorage credential change followed by the guarded restart that starts the new configuration. */
export interface CredentialChangeRequest extends GuardedHostOptions {
  /** The credential, such as `private endpoint key`, named in failures and the confirmation. */
  readonly subject: string
  /** What the write does: a failed restart reports the item as already stored or removed. */
  readonly action: 'stored' | 'removed'
  /** The SecretStorage write: store or delete the item. */
  readonly write: () => PromiseLike<void>
  /** Log line recorded once the write succeeds. */
  readonly saved: string
  /** Message shown after the host and the repaint settle. */
  readonly success: string
}

/**
 * Apply one SecretStorage credential change, then start the new configuration with the guarded restart.
 * A failed write is reported as a SecretStorage failure. A failed restart reports the item as already stored or
 * removed and the new configuration as not started, because the write is durable before the restart begins.
 * @param request - host, view, work check, sink, the write, and the messages it reports.
 * @throws when the write fails, the guard refuses, the restart fails, or the repaint fails.
 */
export async function restartAfterCredentialChange(request: CredentialChangeRequest): Promise<void> {
  try {
    await request.write()
  } catch (error) {
    const reason = messageOf(error)
    request.log(`dsh: ${request.subject} SecretStorage change failed: ${reason}`)
    void vscode.window.showErrorMessage(vscode.l10n.t(
      'DSH could not change the {subject} in VS Code SecretStorage: {reason}',
      { subject: request.subject, reason },
    ))
    throw error
  }
  request.log(request.saved)
  await guardedRestart({
    dsh: request.dsh,
    view: request.view,
    guard: request.guard,
    log: request.log,
    refusal: work => vscode.l10n.t(
      'DSH: the {subject} was {action} in VS Code SecretStorage, but DSH cannot restart while {work} is running; stop it and run DSH: Restart Host to start the new configuration.',
      { subject: request.subject, action: request.action, work },
    ),
    failure: reason => vscode.l10n.t(
      'DSH: the {subject} was {action} in VS Code SecretStorage, but the new configuration did not start: {reason}. Run DSH: Restart Host to try again.',
      { subject: request.subject, action: request.action, reason },
    ),
    success: request.success,
  })
}

/**
 * Confirmation for a cleared SecretStorage credential: only that item was removed.
 * @param subject - the credential the command cleared, such as `private endpoint key`.
 * @returns the confirmation naming the alternative sources this extension did not check.
 */
export function clearedCredentialNotice(subject: string): string {
  return vscode.l10n.t(
    'DSH restarted after clearing the {subject} from VS Code SecretStorage. A managed credential, an environment value, or a .env file may still resolve the route, and this command did not check those sources.',
    { subject },
  )
}
