/**
 * Own the DSH application lifecycle for one VS Code extension activation.
 *
 * The supported production mode is a managed companion process under the Node
 * release owned by the extension. In-process boot remains an explicit internal
 * experiment until it has a complete acceptance matrix.
 *
 * Persistent state (the profile, the Harness home, installed packages) lives
 * directly below the extension storage. Files generated for one launch live in
 * a directory this host instance owns, so several VS Code windows sharing that
 * storage cannot overwrite each other's pending launch inputs.
 * @module @deepseek-ai/dsh-vscode/host/host
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as vscode from 'vscode'
import type { Context } from '@deepseek-ai/cordis'
import { bootDsh, resolveInstallAnchor, resolveInstalledDshVersion, type DshApplication } from './boot.ts'
import { redactProviderUrl, type DiagnosticsInput } from './diagnostics.ts'
import { runtimeCompatibility } from './compat.ts'
import { WebviewBridge, type WebviewBootPayload, type WebviewHost } from './bridge.ts'
import { CompanionBridge, resolveNodeExecutable, type CompanionActivity } from './companion-bridge.ts'
import { ensureSharedHost } from './ensure-host.ts'
import { attachSharedHost, startSharedHostProcess } from './shared-host-process.ts'
import type { SharedHostBridge } from './shared-bridge.ts'
import { createHostToken, resolveHostEndpoint } from '../shared/host-endpoint.ts'
import { credentialEnv, type LaunchCredentials } from './env.ts'
import { officeComposition } from './office.ts'
import { providerPatch } from './provider.ts'
import { UNCONFIGURED_MODEL_ID } from './settings.ts'
import { writeModelGate } from './model-gate.ts'
import { providerEnv, PROVIDER_DEFAULTS, launchModelConfig, selectedProviderKey, type ProviderSettings } from './settings.ts'
import type { HostModelConfig } from '../shared/host-protocol.ts'
import { pluginsPatch, type LocalPlugin } from './plugins.ts'
import { runInTerminal } from './terminal.ts'
import { openFileInEditor } from './editor.ts'
import { resolveBridgeLimits, type BridgeLimits } from '../shared/limits.ts'

/** How the application runs relative to the extension host. */
export type HostMode = 'in-process' | 'companion'

/** Observable application lifecycle. */
export type HostState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'

/** The transport the view drives, whichever mode produced it. */
export interface HostBridge {
  /**
   * Build the boot payload the webview document embeds.
   * @param shellRoot - built Web frontend directory.
   * @returns the payload.
   */
  prepare(shellRoot: string): Promise<WebviewBootPayload>
  /**
   * Handle one webview message.
   * @param message - decoded message.
   */
  handle(message: unknown): Promise<void>
  /** Release host resources for this view. */
  dispose(): Promise<void>
}

/** Lifecycle and service state the view renders. */
export interface HostSnapshot {
  readonly state: HostState
  readonly mode: HostMode
  readonly detail: string
  readonly services: readonly string[]
}

/** One comparison of the open workspace folders against this activation's binding. */
export interface WorkspaceChange {
  /** Root the latest successful launch bound, or undefined before one succeeded. */
  readonly bound: string | undefined
  /** First open folder when it is a local `file:` folder, otherwise undefined. */
  readonly current: string | undefined
  /** Number of open workspace folders. */
  readonly folders: number
  /** Why the first open folder cannot be bound, when it is not a local `file:` folder. */
  readonly refusal: string | undefined
  /** Whether the first open folder differs from the binding. */
  readonly changed: boolean
  /** Whether the binding is no longer among the open folders. */
  readonly removed: boolean
}

/** Boot, expose, and dispose the DSH application. */
export class DshHost {
  private application: DshApplication | undefined
  private companion: CompanionBridge | undefined
  private sharedBridge: SharedHostBridge | undefined
  /** Whether the shared host currently refuses new work while it enters maintenance. */
  private sharedMaintenance = false
  private starting: Promise<void> | undefined
  private state: HostState = 'stopped'
  private failure: string | undefined
  private readonly mode: HostMode
  private sharedConfigMismatch = false
  /**
   * Shared backend is the product path. `DSH_VSCODE_SHARED_HOST=0` selects the
   * per-window companion for comparison and rollback.
   */
  private readonly sharedMode = process.env.DSH_VSCODE_SHARED_HOST !== '0'
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private launchDirectory: string | undefined
  private restoreCompanyEnv: (() => void) | undefined
  private binding: string | undefined
  private launchRoot: string | undefined
  private workspaceRemoved = false

  /**
   * @param extension - the extension context, for storage and the shipped overlay.
   * @param log - diagnostic sink (the extension output channel).
   */
  constructor(
    private readonly extension: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
    private readonly credentials: (companyUrl: string) => Promise<LaunchCredentials> = async () => ({}),
  ) {
    this.mode = resolveHostMode()
  }

  /** How this activation runs the application. */
  get hostMode(): HostMode {
    return this.mode
  }

  /** Monotonic revision of the host lifecycle. */
  get revision(): number {
    return this.generation
  }

  /** Live root context, or undefined in companion mode. */
  get context(): Context | undefined {
    return this.application?.ctx
  }

  /**
   * Ask the companion what work it is running.
   *
   * In-process mode exposes its services on {@link context} instead. A stopped or still-starting companion has no
   * process to ask, so this returns undefined rather than reporting an idle host.
   * @returns the companion's running counts, or undefined when this host is not a running companion.
   * @throws when the companion is running but did not answer the query.
   */
  async companionActivity(): Promise<CompanionActivity | undefined> {
    if (this.sharedMode) {
      const bridge = this.sharedBridge
      // A stopped or still-attaching window has no shared connection to ask; a
      // host it cannot reach is not an idle host.
      if (bridge === undefined || this.state !== 'ready') return undefined
      return await bridge.activity()
    }
    const companion = this.companion
    // Only a ready companion owns running work; a stopped, failed, or still-starting
    // host has nothing to interrupt, so a restart after a crash is not refused.
    if (this.mode !== 'companion' || companion === undefined || this.state !== 'ready') return undefined
    return await companion.activity()
  }

  /**
   * Working directory the running application was launched with: the workspace
   * root this activation bound at start.
   * @throws when no launch has bound a folder, or the bound folder is no longer open.
   */
  get cwd(): string {
    return this.boundWorkspace()
  }

  /**
   * DSH Workspace root: the same folder as {@link cwd}.
   * @throws when no launch has bound a folder, or the bound folder is no longer open.
   */
  get workspacePath(): string {
    return this.boundWorkspace()
  }

  /**
   * Root the latest successful launch bound, or undefined before one succeeded.
   * Launch inputs, diagnostics, {@link cwd} and {@link workspacePath} read this
   * stored binding, so a later `workspaceFolders` change cannot split the page
   * from the companion.
   */
  get workspaceBinding(): string | undefined {
    return this.binding
  }

  /**
   * Compare the open workspace folders with this activation's binding.
   *
   * This is the only workspace lookup that reads `workspaceFolders` after a
   * launch; it records whether the bound root is still open, and the extension
   * reports the comparison before asking for a controlled restart.
   * @returns the comparison, including whether the binding was removed.
   */
  observeWorkspaceFolders(): WorkspaceChange {
    const change = compareWorkspaceFolders(this.binding, vscode.workspace.workspaceFolders)
    this.workspaceRemoved = change.removed
    return change
  }

  /** Configured DSH installation, if any. */
  get runtimePath(): string | undefined {
    return configured('runtimePath') ?? process.env.DSH_VSCODE_RUNTIME
  }

  /** Provider routing settings. */
  get providerSettings(): ProviderSettings {
    const mode = configured('providerMode') === 'openai-compatible' ? 'openai-compatible' : 'deepseek'
    const contextWindow = configuredNumber('llmContextWindow')
    const maxTokens = configuredNumber('llmMaxTokens')
    return {
      mode,
      route: configured('providerRoute') ?? PROVIDER_DEFAULTS.route,
      baseUrl: configured('llmBaseUrl') ?? '',
      model: configured('llmModel') ?? '',
      apiKeyEnv: configured('llmApiKeyEnv') ?? PROVIDER_DEFAULTS.apiKeyEnv,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    }
  }

  /**
   * Collect the deployment facts a support report needs.
   * @returns the diagnostic inputs; no credential value is included.
   */
  async diagnostics(): Promise<DiagnosticsInput> {
    const extensionPath = this.extension.extensionUri.fsPath
    let installAnchor = ''
    let runtimeVersion: string | undefined
    try {
      installAnchor = resolveInstallAnchor(extensionPath, this.runtimePath)
      runtimeVersion = resolveInstalledDshVersion(installAnchor)
    } catch (error) {
      this.log(`dsh: diagnostics could not resolve the runtime: ${describe(error)}`)
    }
    const settings = this.providerSettings
    const credentials = await this.credentials(settings.baseUrl)
    return {
      extensionVersion: String(this.extension.extension.packageJSON.version ?? 'unknown'),
      mode: this.mode,
      cwd: this.reportWorkspace(),
      home: join(this.storageDir, 'home'),
      installAnchor,
      runtimeVersion,
      providerMode: settings.mode,
      providerRoute: settings.route,
      providerBaseUrl: settings.mode === 'deepseek' || settings.baseUrl === '' ? undefined : settings.baseUrl,
      terminalBackend: configured('terminalBackend') ?? 'local',
      providerKey: selectedProviderKey(settings, credentials),
      runtimeDetail: runtimeCompatibility(runtimeVersion, this.runtimeRange()).detail,
    }
  }

  /**
   * Runtime range declared by this extension manifest.
   * @returns the range, or undefined when the manifest declares none.
   */
  private runtimeRange(): string | undefined {
    const manifest = this.extension.extension.packageJSON as { dsh?: { runtimeRange?: unknown } }
    const range = manifest.dsh?.runtimeRange
    return typeof range === 'string' && range !== '' ? range : undefined
  }

  /** Local plugins configured for a private network. */
  get localPlugins(): LocalPlugin[] {
    const configuredPlugins = vscode.workspace.getConfiguration('dsh').get<LocalPlugin[]>('localPlugins')
    return (configuredPlugins ?? []).filter(plugin => typeof plugin?.id === 'string' && typeof plugin?.path === 'string')
  }

  /** Configured Node executable for the companion host, if any. */
  get nodePath(): string | undefined {
    return configured('nodePath') ?? process.env.DSH_VSCODE_NODE ?? packagedNodePath(this.extension.extensionUri.fsPath)
  }

  /**
   * Bounded-transfer budgets both halves of the Webview transport enforce.
   *
   * A value that is not a positive integer is refused with a log line and the
   * default applies, so a mistyped setting cannot disable a bound silently.
   */
  get bridgeLimits(): BridgeLimits {
    return resolveBridgeLimits(key => configuredNumber(key), this.log)
  }

  /** Extension storage directory (profiles, persistent application state). */
  get storageDir(): string {
    return this.extension.globalStorageUri.fsPath
  }

  /**
   * Directory holding the files this activation generates for one launch:
   * overlays and the materialized webview bundles.
   *
   * It is created on first use below {@link storageDir} and is unique to this
   * host, so two windows that share the extension's global storage cannot
   * overwrite each other's pending launch inputs. `stop()` removes it; the
   * persistent profile, home and installed packages above it do not move.
   */
  get launchDir(): string {
    this.launchDirectory ??= createLaunchDirectory(this.storageDir, this.log)
    return this.launchDirectory
  }

  /** Built Web frontend directory: packaged beside the extension or in the source tree. */
  get shellRoot(): string {
    const packaged = join(this.extension.extensionUri.fsPath, 'dist')
    if (existsSync(join(packaged, 'index.html'))) return packaged
    const dev = join(this.extension.extensionUri.fsPath, '..', '..', 'apps', 'web', 'dist')
    if (existsSync(join(dev, 'index.html'))) return dev
    throw new Error('dsh: the built Web shell is missing; run the repository build first')
  }

  /** Subscribe to lifecycle changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Current state for rendering. */
  snapshot(): HostSnapshot {
    const ctx = this.context
    const detail = this.failure ?? stateDetail(this.state, this.mode)
    return {
      state: this.state,
      mode: this.mode,
      detail,
      services: this.state === 'ready' && ctx !== undefined ? liveServices(ctx) : [],
    }
  }

  /**
   * Start the application; concurrent callers share the same attempt.
   *
   * The start resolves the workspace folder once and stores it as this
   * activation's launch root, so the folder a later lookup reports cannot drift
   * from the folder this launch used.
   * @returns settles when the application is live or the mode is ready to spawn.
   */
  async start(): Promise<void> {
    if (this.mode === 'companion') {
      if (this.state === 'starting' || this.state === 'ready') return
      // Validate the executable early so activation reports the real problem.
      this.failure = undefined
      this.state = 'starting'
      this.log(`dsh: managed companion host selected (extension host Node ${process.version})`)
      this.notify()
      try {
        this.prepareLaunchWorkspace()
        // The early check must use the same Node the spawn will use.
        resolveNodeExecutable(this.log, this.nodePath)
      } catch (error) {
        this.failure = describe(error)
        this.state = 'failed'
        this.notify()
        throw error
      }
      return
    }
    if (this.application !== undefined) return
    this.failure = undefined
    this.state = 'starting'
    this.notify()
    try {
      this.prepareLaunchWorkspace()
    } catch (error) {
      this.starting = undefined
      this.failure = describe(error)
      this.state = 'failed'
      this.notify()
      throw error
    }
    this.starting ??= this.boot()
    await this.starting
  }

  /**
   * Create the transport for one webview.
   * @param webview - the webview surface the bridge serves.
   * @returns the bridge the view drives.
   */
  async createBridge(webview: WebviewHost): Promise<HostBridge> {
    if (this.sharedMode) return await this.createSharedBridge(webview)
    const generation = ++this.generation
    if (this.mode === 'companion') {
      const root = this.plannedWorkspace()
      this.state = 'starting'
      this.failure = undefined
      this.notify()
      let bridge: CompanionBridge
      const launchDir = this.launchDir
      try {
        const provider = this.providerSettings
        const overlays = this.generatedOverlays(launchDir, provider, this.localPlugins)
        const credentials = await this.credentials(provider.baseUrl)
        bridge = await CompanionBridge.start({
          extensionPath: this.extension.extensionUri.fsPath,
          ...overlays.length === 0 ? {} : { extraOverlays: overlays },
          env: {
            ...credentialEnv(credentials),
            DSH_VSCODE_SHELL_BACKEND: configured('terminalBackend') ?? 'local',
            ...providerEnv(provider, credentials),
          },
          runInTerminal: (command, cwd, options) => runInTerminal(command, cwd, options),
          // Relative paths resolve against the launch root here: the editor
          // adapter prefers the current first folder, which may already be a
          // different root awaiting its controlled rebind.
          openFile: path => openFileInEditor(isAbsolute(path) ? path : join(root, path), root),
          storageDir: this.storageDir,
          launchDir,
          overlayPath: this.overlayPath(),
          shellRoot: this.shellRoot,
          cwd: root,
          workspacePath: root,
          limits: this.bridgeLimits,
          ...this.runtimePath === undefined ? {} : { runtimePath: this.runtimePath },
          ...this.nodePath === undefined ? {} : { nodePath: this.nodePath },
          onExit: (exit) => {
            if (generation !== this.generation || this.state === 'stopping' || this.state === 'stopped') return
            this.failure = `DSH companion exited unexpectedly (code ${String(exit.code)}, signal ${String(exit.signal)}).`
            this.state = 'failed'
            this.log(`dsh: ${this.failure}`)
            this.notify()
          },
          log: this.log,
        }, webview)
      } catch (error) {
        if (generation === this.generation) {
          this.disposeLaunchDirectory()
          this.failure = describe(error)
          this.state = 'failed'
          this.notify()
        }
        throw error
      }
      if (generation !== this.generation) {
        await bridge.dispose()
        // A stop released this activation while the start was still in flight,
        // so the companion may have recreated launch files after that removal.
        if (this.launchDirectory === undefined) removeLaunchDirectory(this.storageDir, launchDir, this.log)
        throw new Error('dsh: companion start was superseded by a newer host generation')
      }
      await this.companion?.dispose()
      this.companion = bridge
      this.commitLaunchWorkspace()
      this.state = 'ready'
      this.notify()
      return bridge
    }
    const app = this.application
    if (app === undefined) throw new Error('dsh: the application is not running')
    const bridge = new WebviewBridge(app.ctx, this.launchDir, webview, this.log, this.bridgeLimits)
    return {
      prepare: async (shellRoot: string) => await bridge.prepare(shellRoot),
      handle: async (message: unknown) => { await bridge.handle(message) },
      dispose: async () => { bridge.dispose() },
    }
  }

  /**
   * Attach this window to the shared host, starting it when no window serves
   * the storage.
   *
   * The first window generates its launch overlays and starts the host in serve
   * mode; later windows attach without generating a second host, so Sessions,
   * plugins, and execution state stay in one process. Closing this window only
   * ends its connection.
   * @param webview - the webview this window's bridge serves.
   * @returns the attached bridge.
   */
  private async createSharedBridge(webview: WebviewHost): Promise<HostBridge> {
    const generation = ++this.generation
    this.state = 'starting'
    this.failure = undefined
    this.sharedMaintenance = false
    this.notify()
    const endpoint = resolveHostEndpoint(this.storageDir)
    const token = createHostToken(endpoint.tokenPath)
    try {
      const root = this.plannedWorkspace()
      const provider = this.providerSettings
      const plugins = this.localPlugins
      const terminal = configured('terminalBackend') ?? 'local'
      const runtimePath = this.runtimePath
      const nodePath = this.nodePath
      const extensionVersion = extensionVersionOf(this.extension.extension.packageJSON)
      const limits = this.bridgeLimits
      const fingerprint = createHash('sha256').update(JSON.stringify({
        extensionVersion,
        provider,
        terminal,
        plugins: plugins.map(({ id, path }) => ({ id, path })),
        runtimePath,
        nodePath,
      })).digest('hex')
      const ensured = await ensureSharedHost({
        lockPath: endpoint.lockPath,
        storageDir: this.storageDir,
        log: this.log,
        connect: async () => await attachSharedHost({
          endpoint: endpoint.endpoint,
          token,
          clientId: randomUUID(),
          extensionVersion,
          configFingerprint: fingerprint,
          limits,
          workspacePath: root,
          webview,
          log: this.log,
          // A shared host runs every window's tools, so it asks a connected
          // window to run terminal commands and open editors; the answer comes
          // back over the same connection.
          runInTerminal: (command, cwd, options) => runInTerminal(command, cwd, options),
          // Relative paths resolve against this window's root: the editor
          // adapter prefers the first folder, which may await a rebind.
          openFile: path => openFileInEditor(isAbsolute(path) ? path : join(root, path), root),
          onMaintenance: (active, reason) => {
            this.sharedMaintenance = active
            this.log(`dsh: shared maintenance admission ${active ? 'closed' : 'reopened'}${reason === undefined ? '' : `: ${reason}`}`)
            this.notify()
          },
          onExit: (reason) => {
            if (generation !== this.generation || this.state === 'stopping' || this.state === 'stopped') return
            this.failure = `DSH shared host connection ended: ${reason}`
            this.state = 'failed'
            this.log(`dsh: ${this.failure}`)
            this.notify()
          },
        }),
        start: async () => {
          // The host owns the files it boots from: it regenerates the overlays
          // in its own directory and removes it at exit, so the window that
          // started it can close without taking the running host's inputs.
          const launchDir = this.createSharedLaunchDirectory()
          try {
            const overlays = this.generatedOverlays(launchDir, provider, plugins)
            const credentials = await this.credentials(provider.baseUrl)
            await startSharedHostProcess({
              extensionPath: this.extension.extensionUri.fsPath,
              storageDir: this.storageDir,
              launchDir,
              overlayPath: this.overlayPath(),
              shellRoot: this.shellRoot,
              cwd: root,
              workspacePath: root,
              ...overlays.length === 0 ? {} : { extraOverlays: overlays },
              env: {
                ...credentialEnv(credentials),
                DSH_VSCODE_SHELL_BACKEND: terminal,
                ...providerEnv(provider, credentials),
              },
              endpoint: endpoint.endpoint,
              token,
              connectionsDir: join(this.storageDir, 'connections'),
              configFingerprint: fingerprint,
              limits,
              modelConfig: launchModelConfig(provider),
              ...runtimePath === undefined ? {} : { runtimePath },
              ...nodePath === undefined ? {} : { nodePath },
              log: this.log,
            })
          } catch (error) {
            // No host booted from these files, so nothing reads them anymore.
            this.removeSharedLaunchDirectory(launchDir)
            throw error
          }
        },
      })
      if (generation !== this.generation) {
        await ensured.connection.dispose()
        throw new Error('dsh: shared host attach was superseded by a newer host generation')
      }
      await this.sharedBridge?.dispose()
      this.sharedBridge = ensured.connection
      // The host booted once with some window's deployment settings. A window
      // whose provider or plugin settings differ must not assume its changes are
      // live; the shared restart is what makes them take effect.
      this.sharedConfigMismatch = ensured.connection.hello.configFingerprint !== fingerprint
      if (this.sharedConfigMismatch) {
        this.log('dsh: this window joined a shared DSH host started with a different extension version or deployment configuration; use a shared restart when it is idle')
      }
      this.commitLaunchWorkspace()
      this.state = 'ready'
      this.log(`dsh: attached to the shared DSH host${ensured.started ? ' (started for this window)' : ''}`)
      this.notify()
      return ensured.connection
    } catch (error) {
      if (generation === this.generation) {
        this.disposeLaunchDirectory()
        this.failure = describe(error)
        this.state = 'failed'
        this.notify()
      }
      throw error
    }
  }

  /**
   * Dispose the tree or the companion process, then this activation's launch
   * files; a later `start()` boots again.
   */
  async stop(): Promise<void> {
    if (this.sharedMode) {
      await this.stopSharedBridge()
      return
    }
    const companion = this.companion
    const app = this.application
    this.generation++
    this.state = 'stopping'
    this.notify()
    this.companion = undefined
    this.application = undefined
    try {
      await companion?.dispose()
      if (app !== undefined) {
        await app.ctx.fiber.dispose()
        this.log('dsh: application disposed')
      }
    } catch (error) {
      this.log(`dsh: disposal failed: ${describe(error)}`)
      this.failure = `DSH stop failed: ${describe(error)}`
      this.state = 'failed'
      this.notify()
      throw error
    } finally {
      this.restoreCompanyEnv?.()
      this.restoreCompanyEnv = undefined
    }
    // The companion process and the application tree have stopped, so the
    // files this launch generated are no longer read by anything.
    this.disposeLaunchDirectory()
    this.failure = undefined
    this.state = 'stopped'
    this.notify()
  }

  /** Whether this window attached to a host with a different extension version or launch configuration. */
  get configMismatch(): boolean {
    return this.sharedConfigMismatch
  }

  /** Whether the shared host has closed admission for new work while stopping. */
  get maintenancePending(): boolean {
    return this.sharedMaintenance
  }

  /**
   * The deployment model configuration the running application uses.
   *
   * A shared host runs one application started by some window, so this asks
   * that process and every window displays the same answer; a per-window
   * companion starts with this window's settings, so the extension computes
   * the value it just launched with.
   * @returns route, model, and whether a usable model is configured.
   */
  async modelConfig(): Promise<HostModelConfig> {
    const bridge = this.sharedBridge
    if (this.sharedMode && bridge !== undefined) return await bridge.modelConfig()
    return launchModelConfig(this.providerSettings)
  }

  /**
   * End this window's shared connection.
   *
   * The shared host keeps serving other windows and exits on its own after the
   * last connection closes and no work is running, so a window that only closes
   * its view never cancels a task another window is watching.
   */
  private async stopSharedBridge(): Promise<void> {
    const bridge = this.sharedBridge
    this.sharedBridge = undefined
    this.sharedConfigMismatch = false
    this.sharedMaintenance = false
    this.generation++
    this.state = 'stopping'
    this.notify()
    try {
      await bridge?.dispose()
    } catch (error) {
      this.log(`dsh: shared connection disposal failed: ${describe(error)}`)
    }
    // The launch files belong to the shared host, not to this window: another
    // window may still be running work from them after this one closes.
    this.failure = undefined
    this.state = 'stopped'
    this.notify()
  }

  /**
   * Stop and boot again with the folder open at this moment, for the restart
   * and workspace-switch commands.
   *
   * A folder that cannot be bound is refused before the running application is
   * stopped. The binding changes only when the new launch reaches ready; a
   * failed launch keeps the previous binding and reports `failed`.
   *
   * The companion is asked once more here, immediately before it is stopped:
   * the caller's earlier check and this stop are separated by asynchronous work,
   * and a turn or package operation that started in between must not be killed
   * silently. A refusal keeps the running application untouched.
   * @throws when the companion still reports running work, or the launch fails.
   */
  async restart(): Promise<void> {
    const refusal = restartRefusal(await this.companionActivity())
    if (refusal !== undefined) throw new Error(refusal)
    this.prepareLaunchWorkspace()
    if (this.sharedMode) {
      await this.restartSharedHost()
      return
    }
    await this.stop()
    this.failure = undefined
    await this.start()
  }

  /**
   * Stop the running host without booting another one.
   *
   * A window reload or an installed extension update replaces the files the host
   * was launched from; a detached shared host would otherwise keep serving the
   * removed directory, and the next window would attach to it instead of booting
   * the new version. The update flow calls this after a successful install and
   * before the reload, so the window that comes back starts a host from the
   * installed extension. The same admission check as {@link restart} applies: a
   * host with running work refuses the stop instead of losing it.
   * @throws when the host reports running work, or the shared host refuses to stop.
   */
  async stopHost(): Promise<void> {
    const refusal = restartRefusal(await this.companionActivity())
    if (refusal !== undefined) throw new Error(refusal)
    if (!this.sharedMode) {
      await this.stop()
      return
    }
    const bridge = this.sharedBridge
    if (bridge !== undefined) {
      const answer = await bridge.shutdownHost()
      if (!answer.ok) throw new Error(answer.error ?? 'the shared DSH host refused to stop')
    }
    await this.stop()
  }

  /**
   * Stop the shared host and let the next attach start a new one.
   *
   * A host stop affects every connected window, so it is accepted only after the
   * host confirms no work is running. The other windows see their transport end
   * and report the host as offline until a window starts it again or they
   * reconnect.
   */
  private async restartSharedHost(): Promise<void> {
    const bridge = this.sharedBridge
    if (bridge !== undefined) {
      const answer = await bridge.shutdownHost()
      if (!answer.ok) throw new Error(answer.error ?? 'the shared DSH host refused the restart')
    }
    await this.stop()
    this.failure = undefined
    await this.start()
  }

  /**
   * Write every generated overlay for this activation.
   * @param launchDir - the activation's launch directory.
   * @param settings - provider settings captured for this launch.
   * @param plugins - local plugin settings captured for this launch.
   * @returns the overlay paths, in application order.
   */
  private generatedOverlays(launchDir: string, settings: ProviderSettings, plugins: readonly LocalPlugin[]): string[] {
    const overlays: string[] = []
    const office = this.officeOverlay(launchDir)
    if (office !== undefined) overlays.push(office)
    const provider = this.providerOverlay(launchDir, settings)
    if (provider !== undefined) overlays.push(provider)
    const pluginOverlay = this.pluginsOverlay(launchDir, plugins)
    if (pluginOverlay !== undefined) overlays.push(pluginOverlay)
    return overlays
  }

  /**
   * Write the overlay that mounts the bundled Office skills.
   * @param launchDir - the activation's launch directory.
   * @returns the overlay path, or undefined when Office cannot mount in this launch.
   */
  private officeOverlay(launchDir: string): string | undefined {
    if (this.mode === 'in-process' && process.versions.electron !== undefined) {
      this.log('dsh: Office skills need the companion Node executable; in-process mode does not supply one')
      return undefined
    }
    let installAnchor: string
    let node: string
    try {
      installAnchor = resolveInstallAnchor(this.extension.extensionUri.fsPath, this.runtimePath)
      node = this.absoluteNodeExecutable()
    } catch (error) {
      this.log(`dsh: Office skills unavailable: ${describe(error)}`)
      return undefined
    }
    const composition = officeComposition({
      installAnchor,
      node,
      runtimeRoot: this.runtimePath ?? join(this.extension.extensionUri.fsPath, 'runtime'),
    })
    if ('reason' in composition) {
      this.log(`dsh: Office skills unavailable: ${composition.reason}`)
      return undefined
    }
    const path = join(launchDir, 'office.patch.yml')
    writeFileSync(path, composition.patch)
    this.log(`dsh: ${composition.detail}`)
    return path
  }

  /**
   * Resolve the Node executable the Office skill config needs: an absolute file
   * path, including when the setting names the `node` on PATH.
   * @returns the absolute executable path.
   */
  private absoluteNodeExecutable(): string {
    const candidate = this.nodePath
    if (candidate !== undefined && isAbsolute(candidate)) return candidate
    return execFileSync(candidate ?? 'node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  }

  /**
   * Write the local-plugin overlay when plugins are configured.
   * @param launchDir - the activation's launch directory.
   * @param plugins - configured local plugins.
   * @returns the overlay path, or undefined when none are configured.
   */
  private pluginsOverlay(launchDir: string, plugins: readonly LocalPlugin[]): string | undefined {
    const patch = pluginsPatch(plugins)
    if (patch === undefined) return undefined
    const path = join(launchDir, 'plugins.patch.yml')
    writeFileSync(path, patch)
    this.log(`dsh: ${String(plugins.length)} local plugin row(s)`)
    return path
  }

  /**
   * Write the private-provider overlay when one is configured.
   * @param launchDir - the activation's launch directory.
   * @param settings - provider settings captured for this launch.
   * @returns the overlay path, or undefined for the DeepSeek route.
   * @throws when the provider settings are incomplete or invalid.
   */
  private providerOverlay(launchDir: string, settings: ProviderSettings): string | undefined {
    // A deployment with no model yet keeps booting so discovery can run, but its placeholder must never reach the
    // endpoint: the inserted gate refuses it through the llm/stream waterfall.
    const gate = settings.mode === 'deepseek' || settings.model.trim() !== ''
      ? undefined
      : { module: pathToFileURL(writeModelGate(launchDir)).href, model: UNCONFIGURED_MODEL_ID }
    const patch = providerPatch(settings, gate)
    if (patch === undefined) return undefined
    const path = join(launchDir, 'provider.patch.yml')
    writeFileSync(path, patch)
    this.log(`dsh: provider route ${settings.route} -> ${redactProviderUrl(settings.baseUrl)} (${settings.model})`)
    return path
  }

  private overlayPath(): string {
    const overlayPath = join(this.extension.extensionUri.fsPath, 'profile', 'vscode.patch.yml')
    if (!existsSync(overlayPath)) throw new Error(`dsh: overlay patch is missing at ${overlayPath}`)
    return overlayPath
  }

  private async boot(): Promise<void> {
    const extensionPath = this.extension.extensionUri.fsPath
    const overlayPath = this.overlayPath()
    const provider = this.providerSettings
    const plugins = this.localPlugins
    const credentials = await this.credentials(provider.baseUrl)
    // The extension owns an isolated Harness home: sharing the installed
    // product's home mixes storage schemas from a different release into this
    // tree, which the storage domain refuses at open.
    const previousCompanyKey = process.env[provider.apiKeyEnv]
    this.restoreCompanyEnv = () => {
      if (previousCompanyKey === undefined) delete process.env[provider.apiKeyEnv]
      else process.env[provider.apiKeyEnv] = previousCompanyKey
    }
    Object.assign(process.env, credentialEnv(credentials), providerEnv(provider, credentials))
    process.env.DSH_HOME = join(this.extension.globalStorageUri.fsPath, 'home')
    this.log(`dsh: harness home ${process.env.DSH_HOME}`)
    try {
      // Overlay generation allocates this activation's launch directory, so a
      // failure here is covered by the same cleanup as a failed boot.
      const launchDir = this.launchDir
      const root = this.plannedWorkspace()
      const overlays = this.generatedOverlays(launchDir, provider, plugins)
      this.notify()
      const app = await bootDsh({
        extensionPath,
        storageDir: this.extension.globalStorageUri.fsPath,
        overlayPath,
        ...overlays.length === 0 ? {} : { extraOverlays: overlays },
        cwd: root,
        workspacePath: root,
        ...this.runtimePath === undefined ? {} : { runtimePath: this.runtimePath },
        log: this.log,
      })
      this.application = app
      this.commitLaunchWorkspace()
      this.failure = undefined
      this.state = 'ready'
      this.log(`dsh: application booted with ${String(liveServices(app.ctx).length)} live services`)
    } catch (error) {
      this.restoreCompanyEnv()
      this.restoreCompanyEnv = undefined
      this.failure = describe(error)
      this.state = 'failed'
      this.log(`dsh: boot failed: ${this.failure}`)
      this.disposeLaunchDirectory()
      throw error
    } finally {
      this.starting = undefined
      this.notify()
    }
  }

  /**
   * Resolve the folder this launch binds, once per start, and store it as the
   * pending launch root. The binding itself changes only after a successful
   * launch, so a failed switch leaves the previous binding in place.
   * @returns the resolved local workspace root.
   * @throws when no folder is open or the first root is not a local file: folder.
   */
  private prepareLaunchWorkspace(): string {
    const root = resolveWorkspaceFolder(vscode.workspace.workspaceFolders)
    const repeated = this.launchRoot === root
    this.launchRoot = root
    if (this.binding === undefined) {
      this.binding = root
      this.workspaceRemoved = false
    } else if (this.binding === root) {
      this.workspaceRemoved = false
    } else if (!repeated) {
      this.log(`dsh: the next launch binds ${root}; the running binding stays ${this.binding}`)
    }
    return root
  }

  /**
   * @returns the root a launch input must use: the pending launch root, else the binding.
   * @throws when no launch bound a folder, or the bound folder is no longer open.
   */
  private plannedWorkspace(): string {
    return this.launchRoot ?? this.boundWorkspace()
  }

  /** Record the pending launch root as the binding after a launch reached ready. */
  private commitLaunchWorkspace(): void {
    const root = this.launchRoot
    if (root === undefined) return
    this.launchRoot = undefined
    if (this.binding !== root) this.log(`dsh: workspace binding is now ${root}`)
    this.binding = root
    this.workspaceRemoved = false
  }

  /**
   * @returns the stored binding every launched input and view request uses.
   * @throws when nothing is bound, or the bound folder stopped being open.
   */
  private boundWorkspace(): string {
    const root = this.binding
    if (root === undefined) {
      throw new Error('dsh: DSH has not bound a workspace folder; open a local folder and start DSH')
    }
    if (this.workspaceRemoved) throw new Error(removedWorkspaceMessage(root))
    return root
  }

  /**
   * @returns the workspace fact diagnostics report; a removed binding is still named.
   */
  private reportWorkspace(): string {
    const root = this.binding
    if (root === undefined) return '<not bound>'
    return this.workspaceRemoved ? `${root} (no longer open)` : root
  }

  /** Remove the launch directory this activation owns, when it allocated one. */
  private disposeLaunchDirectory(): void {
    const directory = this.launchDirectory
    this.launchDirectory = undefined
    if (directory === undefined) return
    removeLaunchDirectory(this.storageDir, directory, this.log)
  }

  /**
   * Create the shared host's launch directory.
   *
   * The directory belongs to the host, not to the window that happens to start
   * it: this runs under the spawn lock, so replacing the root cannot remove
   * files a live host is reading, and the host removes its own directory when
   * it exits.
   * @returns the directory the host boots from.
   */
  private createSharedLaunchDirectory(): string {
    const root = join(this.storageDir, SHARED_LAUNCH_ROOT)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const directory = join(root, randomUUID())
    mkdirSync(directory)
    this.log(`dsh: shared host launch files are in ${directory}`)
    return directory
  }

  /**
   * Remove a shared host launch directory no host booted from.
   * @param directory - directory {@link createSharedLaunchDirectory} returned.
   */
  private removeSharedLaunchDirectory(directory: string): void {
    removeSharedHostLaunchDirectory(this.storageDir, directory, this.log)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.log(`dsh: view listener failed: ${describe(error)}`)
      }
    }
  }
}

/** Directory below the extension storage that holds one directory per launch. */
const LAUNCH_ROOT = 'launch'

/** Directory below the extension storage that holds the shared host's generated files. */
const SHARED_LAUNCH_ROOT = 'shared-launch'

/**
 * Create the launch directory for one host activation.
 * @param storageDir - extension storage directory.
 * @param log - diagnostic sink.
 * @returns the absolute directory, created exclusively for this activation.
 */
function createLaunchDirectory(storageDir: string, log: (line: string) => void): string {
  const root = join(storageDir, LAUNCH_ROOT)
  mkdirSync(root, { recursive: true })
  const directory = join(root, randomUUID())
  mkdirSync(directory)
  log(`dsh: launch files for this window are in ${directory}`)
  return directory
}

/**
 * Remove one activation's launch directory.
 *
 * Only a directory exactly one level below this storage's launch root is
 * removed. A deeper path, the launch root itself, or a path outside it is kept
 * and reported, so cleanup can never target another window's directory.
 * @param storageDir - extension storage directory.
 * @param directory - the launch directory this activation allocated.
 * @param log - diagnostic sink.
 */
function removeLaunchDirectory(storageDir: string, directory: string, log: (line: string) => void): void {
  const launchRoot = join(storageDir, LAUNCH_ROOT)
  const relativePath = relative(launchRoot, directory)
  const segments = relativePath.split(sep).filter(segment => segment !== '')
  if (isAbsolute(relativePath) || segments.length !== 1 || segments[0] === '..') {
    log(`dsh: kept launch files in an unexpected directory ${directory}`)
    return
  }
  try {
    rmSync(directory, { recursive: true, force: true })
    log(`dsh: removed launch files ${directory}`)
  } catch (error) {
    // A stopped host must still reach 'stopped' when its files cannot be removed.
    log(`dsh: could not remove launch files ${directory}: ${describe(error)}`)
  }
}

/**
 * Remove one shared host launch directory.
 *
 * Only a directory exactly one level below this storage's shared launch root is
 * removed, so a failure path cannot delete another window's or a live host's
 * files.
 * @param storageDir - extension storage directory.
 * @param directory - the directory {@link DshHost.createSharedLaunchDirectory} returned.
 * @param log - diagnostic sink.
 */
function removeSharedHostLaunchDirectory(storageDir: string, directory: string, log: (line: string) => void): void {
  const root = join(storageDir, SHARED_LAUNCH_ROOT)
  const relativePath = relative(root, directory)
  const segments = relativePath.split(sep).filter(segment => segment !== '')
  if (isAbsolute(relativePath) || segments.length !== 1 || segments[0] === '..') {
    log(`dsh: kept shared host launch files in an unexpected directory ${directory}`)
    return
  }
  try {
    rmSync(directory, { recursive: true, force: true })
    log(`dsh: removed shared host launch files ${directory}`)
  } catch (error) {
    log(`dsh: could not remove shared host launch files ${directory}: ${describe(error)}`)
  }
}

/**
 * The workspace folder fields this adapter qualifies before use.
 */
export interface WorkspaceFolderLike {
  readonly uri: {
    readonly scheme: string
    readonly authority: string
    readonly fsPath: string
  }
}

/**
 * Resolve the single local workspace folder this extension accepts.
 *
 * Only local `file:` roots run in this version: another scheme (Remote SSH,
 * WSL, container or a virtual filesystem) has no local execution directory. A
 * `file:` root with a non-empty authority is a UNC share and still names a
 * local filesystem path. The single-folder policy binds the first root only,
 * so a multi-root window uses its first folder.
 * @param folders - VS Code workspace roots in display order.
 * @returns the local filesystem path of the first root.
 * @throws when no folder is open, or the first root is not a local file folder.
 */
export function resolveWorkspaceFolder(folders: readonly WorkspaceFolderLike[] | undefined): string {
  const folder = folders?.[0]
  if (folder === undefined) throw new Error('dsh: open a VS Code folder before starting DSH')
  const { scheme, fsPath } = folder.uri
  if (scheme !== 'file') throw new Error(unsupportedSchemeMessage(scheme))
  return fsPath
}

/**
 * Compare the open workspace folders with one activation's binding.
 *
 * The first root is the only bound folder. A root appended after the first one
 * is no change; reordering or replacing the first root is. A removed binding
 * names work that must be refused until a controlled restart binds the folder
 * open at that time.
 * @param bound - root the latest successful launch bound.
 * @param folders - VS Code workspace roots in display order.
 * @returns the comparison, including whether the binding is still open.
 */
export function compareWorkspaceFolders(
  bound: string | undefined,
  folders: readonly WorkspaceFolderLike[] | undefined,
): WorkspaceChange {
  const open = folders ?? []
  const first = open[0]
  const refusal = first !== undefined && first.uri.scheme !== 'file' ? unsupportedSchemeMessage(first.uri.scheme) : undefined
  const current = first !== undefined && refusal === undefined ? first.uri.fsPath : undefined
  const removed = bound !== undefined
    && !open.some(folder => folder.uri.scheme === 'file' && sameWorkspacePath(folder.uri.fsPath, bound))
  const changed = refusal !== undefined
    ? true
    : current === undefined || bound === undefined
      ? current !== bound
      : !sameWorkspacePath(current, bound)
  return {
    bound,
    current,
    folders: open.length,
    refusal,
    changed,
    removed,
  }
}

/**
 * @param left - one workspace path.
 * @param right - another workspace path.
 * @returns whether both name the same folder; Windows paths compare without case.
 */
function sameWorkspacePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * @param scheme - workspace folder URI scheme.
 * @returns the refusal for a folder this version cannot run in.
 */
function unsupportedSchemeMessage(scheme: string): string {
  return `dsh: unsupported workspace folder scheme ${JSON.stringify(scheme)}; this version runs only in local file: folders. Open a local folder to run DSH.`
}

/**
 * @param root - the binding that stopped being open.
 * @returns the refusal for work that depends on that binding, with the recovery path.
 */
function removedWorkspaceMessage(root: string): string {
  return `dsh: the workspace folder ${root} is no longer open. Work that needs it is refused; reopen ${root} and restart DSH, or restart DSH to bind the open folder.`
}

/**
 * @param manifest - extension package manifest.
 * @returns the declared version, or `unknown` when it is absent.
 */
function extensionVersionOf(manifest: unknown): string {
  const version = (manifest as { version?: unknown } | null)?.version
  return typeof version === 'string' && version !== '' ? version : 'unknown'
}

/**
 * @param extensionPath - extension root.
 * @returns the bundled Node executable when the release contains one.
 */
function packagedNodePath(extensionPath: string): string | undefined {
  const candidate = process.platform === 'win32'
    ? join(extensionPath, 'runtime', 'node.exe')
    : join(extensionPath, 'runtime', 'bin', 'node')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Select the production host mode.
 *
 * Current VS Code extension hosts select managed companion mode regardless of
 * their Electron version. In-process selection requires an explicit internal
 * experiment flag and a compatible extension host.
 * @param env - environment carrying the internal experiment flag.
 * @returns the selected host mode.
 */
export function resolveHostMode(env: NodeJS.ProcessEnv = process.env): HostMode {
  return env.DSH_VSCODE_EXPERIMENTAL_IN_PROCESS === '1' && extensionHostSupportsDsh()
    ? 'in-process'
    : 'companion'
}

/**
 * Whether this extension host can boot DSH in-process: the runtime resolver's
 * native module accepts only plain Node releases and recent Electron builds.
 * @returns true when an in-process boot may succeed.
 */
export function extensionHostSupportsDsh(): boolean {
  const versions = process.versions as { electron?: string }
  if (versions.electron === undefined) return nodeVersionAtLeast(24, 9)
  // The resolver's native module refuses any Electron runtime outside its
  // fingerprint list; VS Code 1.117 ships Electron 37, so today every VS Code
  // extension host takes the companion path.
  const major = Number.parseInt(versions.electron.split('.')[0] ?? '0', 10)
  return SUPPORTED_ELECTRON_MAJORS.has(major) && nodeVersionAtLeast(24, 9)
}

/** Electron majors whose runtime fingerprint the resolver's native module accepts. */
const SUPPORTED_ELECTRON_MAJORS: ReadonlySet<number> = new Set([43, 44, 45])

/**
 * @param major - required major version.
 * @param minor - required minor version.
 * @returns whether the current process satisfies it.
 */
function nodeVersionAtLeast(major: number, minor: number): boolean {
  const [currentMajor = 0, currentMinor = 0] = process.versions.node.split('.').map(part => Number.parseInt(part, 10))
  return currentMajor > major || (currentMajor === major && currentMinor >= minor)
}

/**
 * @param state - lifecycle state.
 * @param mode - selected host mode.
 * @returns a user-facing explanation for the state.
 */
function stateDetail(state: HostState, mode: HostMode): string {
  switch (state) {
    case 'stopped':
      return 'DSH is stopped.'
    case 'starting':
      return mode === 'companion'
        ? 'Starting the managed DSH companion...'
        : 'Booting the DSH application in the extension host...'
    case 'ready':
      return mode === 'companion'
        ? 'DSH is running in the managed companion process.'
        : 'DSH is running in the extension host.'
    case 'stopping':
      return 'Stopping DSH...'
    case 'failed':
      return 'DSH failed to start.'
  }
}

/**
 * @param activity - work the running companion reported, or undefined when this host is not a companion.
 * @returns why a restart must not start, or undefined when nothing observable is running.
 */
export function restartRefusal(activity: CompanionActivity | undefined): string | undefined {
  if (activity === undefined) return undefined
  const parts: string[] = []
  if (activity.runningTurns > 0) parts.push(`${String(activity.runningTurns)} running ${activity.runningTurns === 1 ? 'turn' : 'turns'}`)
  if (activity.packageOperations > 0) {
    parts.push(`${String(activity.packageOperations)} running package ${activity.packageOperations === 1 ? 'operation' : 'operations'}`)
  }
  if (activity.runningTerminals > 0) {
    parts.push(`${String(activity.runningTerminals)} running terminal ${activity.runningTerminals === 1 ? 'command' : 'commands'}`)
  }
  if (parts.length === 0) return undefined
  return `DSH still reports ${parts.join(', ')}; the restart was not started. Stop it and try again.`
}

/**
 * Read one DSH setting.
 * @param key - setting name below the `dsh` section.
 * @returns the configured string, or undefined when unset or empty.
 */
function configured(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration('dsh').get<string>(key)
  return value === undefined || value === '' ? undefined : value
}

/**
 * Read one numeric DSH setting.
 * @param key - setting name below the `dsh` section.
 * @returns the finite configured number, or undefined when unset or not a number.
 */
function configuredNumber(key: string): number | undefined {
  const value: unknown = vscode.workspace.getConfiguration('dsh').get<number>(key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Service keys the view reports as proof the tree is live. */
const REPORTED_SERVICES = [
  'agents',
  'sessions',
  'tools',
  'llm',
  'connection',
  'clientModules',
  'typertGateway',
] as const

/**
 * Read which reported services the tree provides.
 * @param ctx - live root context.
 * @returns service keys present on this context.
 */
export function liveServices(ctx: Context): string[] {
  return REPORTED_SERVICES.filter(key => ctx.get(key) !== undefined)
}

/**
 * @param error - thrown value.
 * @returns a single-line description for logs and view text.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
