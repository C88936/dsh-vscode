/**
 * The intranet update flow: fetch the feed, decide, download, verify, install.
 *
 * The controller is inert until `dsh.update.feedUrl` names a feed. It owns the state machine and the once-per-interval
 * gate, and it delegates every VS Code surface — the notification, the progress-reporting download, and the install —
 * to the caller, so the flow itself stays testable without an extension host. A failing step reports its reason and
 * leaves the installed extension untouched: the flow never installs a file the download did not verify against the
 * feed's digest and size.
 * @module @deepseek-ai/dsh-vscode/host/update/controller
 */
import { currentTargetPlatform, evaluateUpdate, type AvailableUpdate, type UpdateIneligibleCode } from './check.ts'
import { downloadUpdate, type DownloadedUpdate, type DownloadResult } from './download.ts'
import { describeUpdateError } from './errors.ts'
import type { InstallFailureCode, InstallOutcome } from './install.ts'
import { parseUpdateManifest, updateUrlError } from './manifest.ts'
import { MAX_SHARE_FEED_BYTES, readUpdateShare, windowsUpdateShare } from './share.ts'
import {
  describeUpdateState,
  UpdateStateMachine,
  type InstallingUpdateState,
  type StagedUpdateState,
  type UpdateState,
} from './state.ts'

/** How one check was started: by the periodic schedule, or by a command. */
export type UpdateCheckTrigger = 'automatic' | 'manual'

/** Outcome of one check. */
export type UpdateCheckOutcome =
  | { readonly status: 'available'; readonly update: AvailableUpdate }
  | { readonly status: 'staged'; readonly staged: DownloadedUpdate }
  | { readonly status: 'current'; readonly detail: string }
  | { readonly status: 'ineligible'; readonly code: UpdateIneligibleCode; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'busy'; readonly reason: string }

/** Outcome of one install action, which downloads first when no verified file is staged. */
export type UpdateInstallOutcome =
  | {
    readonly status: 'installed'
    /** Installed version. */
    readonly version: string
    /** Whether the window reload command was accepted. */
    readonly reloaded: boolean
    /** Why the window did not reload, when it did not; the version is installed either way. */
    readonly detail: string | undefined
  }
  | { readonly status: 'busy'; readonly reason: string }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'deferred'; readonly reason: string }
  | { readonly status: 'failed'; readonly code: InstallFailureCode | 'download'; readonly reason: string }
  | { readonly status: 'nothing-to-install'; readonly reason: string }

/** How long one feed request may take before it is abandoned. */
const FEED_TIMEOUT_MS = 15_000

/** Inputs for one update controller. */
export interface UpdateControllerOptions {
  /** Identifier of the installed extension, as `publisher.name`. */
  readonly extensionId: string
  /** Version of the installed extension. */
  readonly localVersion: string
  /** Version of the VS Code this window runs. */
  readonly vscodeVersion: string
  /** Platform of this window; absent reads the running process. */
  readonly targetPlatform?: string
  /** Directory inside the extension's global storage that receives verified VSIX files. */
  readonly directory: string
  /**
   * @returns the configured feed URL; an empty value keeps every automatic action off.
   */
  readonly feedUrl: () => string
  /**
   * @returns the configured automatic interval in minutes; 0 keeps the feature manual only.
   */
  readonly checkIntervalMinutes: () => number
  /**
   * Report an eligible update and ask whether to install it now.
   * @param update - the applicable feed.
   * @returns whether the user asked to install and reload now.
   */
  readonly notifyAvailable?: (update: AvailableUpdate) => Promise<boolean>
  /** Receives accepted update state changes for the window's status item. */
  readonly onStateChange?: (state: UpdateState) => void
  /**
   * Run one download with the caller's progress and cancellation surface.
   * @param run - starts the download with the signal the caller cancels.
   * @returns the download result.
   */
  readonly download: (run: (signal: AbortSignal) => Promise<DownloadResult>) => Promise<DownloadResult>
  /**
   * Apply one verified VSIX and reload the window.
   * @param staged - the verified file to install.
   * @returns the install outcome.
   */
  readonly install: (staged: DownloadedUpdate) => Promise<InstallOutcome>
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** Network implementation; absent uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Clock; absent uses the wall clock. */
  readonly now?: () => number
}

/**
 * Own one window's update flow.
 *
 * One controller serves one activation: the state, the in-flight guard, and the last automatic run belong to the
 * instance, so a second window keeps its own view of the same feed.
 */
export class UpdateController {
  private readonly machine: UpdateStateMachine
  private readonly now: () => number
  private checking = false
  private installing = false
  private lastAutomaticAt: number | undefined

  /** @param options - the installed facts, the settings readers, and the VS Code surfaces. */
  constructor(private readonly options: UpdateControllerOptions) {
    this.machine = new UpdateStateMachine(options.onStateChange)
    this.now = options.now ?? Date.now
  }

  /** @returns the current update state. */
  get state(): UpdateState {
    return this.machine.state
  }

  /**
   * Read the feed and decide whether it applies to this window.
   *
   * An automatic run also asks the user, through {@link UpdateControllerOptions.notifyAvailable}, whether to install
   * now; a manual run returns so its command can present the version, the notes, and the source. An automatic run
   * stops before any request when no feed URL is configured, when the configured interval is 0, or when the previous
   * automatic run is younger than that interval.
   * @param trigger - how the check was started.
   * @returns the applicable update, or the condition that ended the check.
   */
  async check(trigger: UpdateCheckTrigger): Promise<UpdateCheckOutcome> {
    const feedUrl = this.options.feedUrl().trim()
    const share = process.platform === 'win32' ? windowsUpdateShare(feedUrl) : undefined
    if (feedUrl === '') return { status: 'skipped', reason: 'no update feed URL is configured' }
    // A feed is either a directory read through its file transport or an HTTP(S)
    // document. Anything else — most often a local drive path — names no
    // transport, so report that instead of failing later on the download field.
    if (share === undefined && !/^https?:/iu.test(feedUrl)) {
      return this.fail(`the update feed ${feedUrl} must be a UNC share directory or an HTTP(S) URL`)
    }
    if (this.checking) return { status: 'busy', reason: 'an update check is already running' }
    const current = this.state
    if (current.name === 'staged') return { status: 'staged', staged: stagedFile(current) }
    if (current.name === 'downloading' || current.name === 'installing') {
      return { status: 'busy', reason: `an update is already ${current.name}` }
    }
    if (trigger === 'automatic') {
      const minutes = this.options.checkIntervalMinutes()
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { status: 'skipped', reason: 'automatic update checks are disabled' }
      }
      const at = this.now()
      if (this.lastAutomaticAt !== undefined && at - this.lastAutomaticAt < minutes * 60_000) {
        return { status: 'skipped', reason: `the previous automatic check was less than ${String(minutes)} minutes ago` }
      }
      this.lastAutomaticAt = at
    }
    this.checking = true
    try {
      const started = this.machine.apply({ type: 'check-started' })
      if (!started.ok) return { status: 'busy', reason: started.detail }

      let text: string
      try {
        const response = share === undefined ? await this.send(feedUrl)
          : readUpdateShare(share, 'release-feed.json', AbortSignal.timeout(FEED_TIMEOUT_MS))
        if (!response.ok) return this.fail(`the update feed answered HTTP ${String(response.status)}`)
        text = await response.text()
        if (share !== undefined && Buffer.byteLength(text) > MAX_SHARE_FEED_BYTES) {
          return this.fail('the update feed exceeds the Windows share size limit')
        }
      } catch (error) {
        return this.fail(`the update feed ${feedUrl} could not be read: ${describeUpdateError(error)}`)
      }

      const parsed = parseUpdateManifest(text, share)
      if (!parsed.ok) {
        return this.fail(`the update feed is invalid (${parsed.problem.field}: ${parsed.problem.detail})`)
      }
      const eligibility = evaluateUpdate({
        manifest: parsed.manifest,
        extensionId: this.options.extensionId,
        localVersion: this.options.localVersion,
        vscodeVersion: this.options.vscodeVersion,
        targetPlatform: this.options.targetPlatform ?? currentTargetPlatform(),
      })
      if (!eligibility.eligible) {
        this.machine.apply({ type: 'no-update' })
        this.options.log(`dsh: update check found no applicable update: ${eligibility.reason}`)
        return { status: 'ineligible', code: eligibility.code, reason: eligibility.reason }
      }
      const available = this.machine.apply({ type: 'update-available', manifest: parsed.manifest })
      if (!available.ok) return { status: 'busy', reason: available.detail }
      const update = eligibility.update
      this.options.log(
        `dsh: update ${update.version} is available for ${this.options.extensionId} `
        + `(installed ${update.localVersion}; source ${parsed.manifest.url})`,
      )
      if (trigger === 'automatic' && await this.askToInstall(update)) await this.installAndReload()
      return { status: 'available', update }
    } finally {
      this.checking = false
    }
  }

  /**
   * Download when needed, install the verified file, and reload the window.
   *
   * A verified file already staged for the same version is reused rather than downloaded again, and a download the
   * caller cancelled returns the flow to `idle` with nothing installed.
   * @returns the installed version, or the condition that stopped the install and what remains true afterwards.
   */
  async installAndReload(): Promise<UpdateInstallOutcome> {
    if (this.installing) return { status: 'busy', reason: 'an update install is already running' }
    this.installing = true
    try {
      return await this.runInstall()
    } finally {
      this.installing = false
    }
  }

  /**
   * The single install pass, called only while {@link installAndReload} holds the in-flight flag.
   * @returns the install outcome.
   */
  private async runInstall(): Promise<UpdateInstallOutcome> {
    const current = this.state
    let staged: DownloadedUpdate
    if (current.name === 'staged') {
      staged = stagedFile(current)
    } else if (current.name === 'available') {
      const started = this.machine.apply({ type: 'download-started' })
      if (!started.ok) return { status: 'nothing-to-install', reason: started.detail }
      const result = await this.options.download(async signal => await downloadUpdate({
        manifest: current.manifest,
        directory: this.options.directory,
        signal,
        ...this.options.fetch === undefined ? {} : { fetch: this.options.fetch },
      }))
      if (!result.ok) {
        if (result.failure.code === 'cancelled') {
          this.machine.apply({ type: 'reset' })
          this.options.log(`dsh: ${result.failure.detail}`)
          return { status: 'cancelled', reason: result.failure.detail }
        }
        const failed = this.fail(`the update download failed (${result.failure.code}): ${result.failure.detail}`)
        return { status: 'failed', code: 'download', reason: failed.reason }
      }
      const verified = this.machine.apply({
        type: 'download-staged',
        path: result.downloaded.path,
        sha256: result.downloaded.sha256,
      })
      if (!verified.ok) return { status: 'nothing-to-install', reason: verified.detail }
      staged = result.downloaded
      this.options.log(`dsh: verified ${result.downloaded.path} (${String(result.downloaded.size)} bytes)`)
    } else {
      return {
        status: 'nothing-to-install',
        reason: `no update is ready to install (state ${describeUpdateState(current)})`,
      }
    }

    const started = this.machine.apply({ type: 'install-started' })
    if (!started.ok) return { status: 'nothing-to-install', reason: started.detail }
    const outcome = await this.options.install(staged)
    if (outcome.ok) {
      this.machine.apply({ type: 'install-finished' })
      return { status: 'installed', version: outcome.version, reloaded: true, detail: undefined }
    }
    if (outcome.code === 'reload-failed' || outcome.code === 'handover-failed') {
      // The extension is installed; only the reload (or the host handover that
      // must precede it) did not complete, so the flow is not a failed update.
      this.machine.apply({ type: 'reset' })
      this.options.log(`dsh: ${outcome.detail}`)
      return { status: 'installed', version: staged.version, reloaded: false, detail: outcome.detail }
    }
    if (outcome.code === 'work-running') {
      // Work is still running and the user declined; the verified file stays staged for the next attempt.
      this.machine.apply({ type: 'install-refused' })
      this.options.log(`dsh: ${outcome.detail}`)
      return { status: 'deferred', reason: outcome.detail }
    }
    return { status: 'failed', code: outcome.code, reason: this.fail(outcome.detail).reason }
  }

  /**
   * Start the automatic schedule and run the activation check.
   *
   * A configured interval of 0 starts nothing. The activation check runs once, and the periodic check runs only when
   * the interval gate allows it, so one activation never checks more often than the interval.
   * @returns a disposer that stops the periodic check.
   */
  start(): () => void {
    const minutes = this.options.checkIntervalMinutes()
    if (!Number.isFinite(minutes) || minutes <= 0) return () => {}
    const timer = setInterval(() => { this.runAutomatic() }, minutes * 60_000)
    this.runAutomatic()
    return () => { clearInterval(timer) }
  }

  /** @param update - the applicable feed. @returns whether the user asked to install now. */
  private async askToInstall(update: AvailableUpdate): Promise<boolean> {
    try {
      return await this.options.notifyAvailable?.(update) ?? false
    } catch (error) {
      this.options.log(`dsh: the update notification failed: ${describeUpdateError(error)}`)
      return false
    }
  }

  /** Run one scheduled check, reporting a defect that escaped the flow instead of leaving it unhandled. */
  private runAutomatic(): void {
    void this.check('automatic').catch((error: unknown) => {
      this.options.log(`dsh: automatic update check failed: ${describeUpdateError(error)}`)
    })
  }

  /**
   * @param url - feed address.
   * @returns the feed response; a redirect rejects, because the manifest must name the artifact's own address.
   */
  private async send(url: string): Promise<Response> {
    const invalid = updateUrlError(url)
    if (invalid !== undefined) throw new Error(invalid)
    const feed = new URL(url)
    if (feed.pathname.endsWith('/')) feed.pathname += 'release-feed.json'
    const request = this.options.fetch ?? globalThis.fetch
    return await request(feed.href, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    })
  }

  /**
   * Record one failed attempt.
   * @param reason - readable reason.
   * @returns the failed check outcome.
   */
  private fail(reason: string): { readonly status: 'failed'; readonly reason: string } {
    this.machine.apply({ type: 'failed', reason })
    this.options.log(`dsh: update failed: ${reason}`)
    return { status: 'failed', reason }
  }
}

/**
 * @param state - a state carrying a verified file.
 * @returns the verified file record the install reads.
 */
function stagedFile(state: StagedUpdateState | InstallingUpdateState): DownloadedUpdate {
  return { version: state.version, path: state.path, sha256: state.sha256, size: state.manifest.size }
}
