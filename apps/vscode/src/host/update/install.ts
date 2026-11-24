/**
 * Apply one verified VSIX and reload the window that runs it.
 *
 * The install, the host handover, and the reload are separate steps, so a
 * failure after the install is reported as its own outcome: the new version is
 * installed and loads the next time the window reloads, while the running
 * window keeps working. The handover stops the DSH host that was launched from
 * the extension directory the install replaces; without it a detached shared
 * host survives the reload and serves the removed files. A running DSH turn is
 * never interrupted silently: the extension's existing activity monitor
 * supplies the answer (`RestartActivityMonitor.blockers()` reads live Agents
 * through the live context and running work through the companion's
 * `host-activity` query), and `DshHost.stopHost()` repeats the check before it
 * stops. When the monitor reports work, or cannot answer at all, the caller asks
 * the user before installing and reloading, and a refusal leaves the staged file
 * in place for a later attempt.
 * @module @deepseek-ai/dsh-vscode/host/update/install
 */
import * as vscode from 'vscode'
import { describeUpdateError } from './errors.ts'

/** Running DSH work the install must not interrupt on its own. */
export interface UpdateInstallGuard {
  /**
   * @returns what installing and reloading would interrupt, as full explanations; empty when nothing observable runs.
   * A guard that cannot establish the work returns a blocker rather than an empty list.
   */
  blockers(): readonly string[] | Promise<readonly string[]>
}

/** What the user is asked to confirm before an install that interrupts running work. */
export interface InstallConfirmation {
  /** Version about to be installed. */
  readonly version: string
  /** Running work the install and reload interrupt, or why it could not be established. */
  readonly work: readonly string[]
}

/** Why one install stopped. */
export type InstallFailureCode = 'work-running' | 'install-failed' | 'handover-failed' | 'reload-failed'

/** Outcome of one install. */
export type InstallOutcome =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly code: InstallFailureCode; readonly detail: string }

/** Executes one VS Code command, as the extension host does. */
export type ExecuteCommand = (command: string, ...args: readonly unknown[]) => Thenable<unknown>

/** Inputs for one install. */
export interface InstallStagedUpdateOptions {
  /** Absolute path of the verified VSIX. */
  readonly path: string
  /** Version the file was published for. */
  readonly version: string
  /** Running work the install and reload must not interrupt silently. */
  readonly guard: UpdateInstallGuard
  /**
   * Ask the user before an install that interrupts running work.
   * @returns whether to install and reload now.
   */
  readonly confirm: (request: InstallConfirmation) => PromiseLike<boolean>
  /** Diagnostic sink. */
  readonly log?: (line: string) => void
  /**
   * Stop the running DSH host after the install and before the reload.
   *
   * A detached shared host keeps serving the extension directory the update
   * replaces; without this handover the reloaded window attaches to that old
   * process and its Webview shell cannot load. The extension passes
   * `DshHost.stopHost()`. A rejection stops the reload and reports that the new
   * version is installed but the previous host is still running.
   */
  readonly handover?: () => Promise<void>
  /** Command executor; absent runs the command through `vscode.commands`. */
  readonly executeCommand?: ExecuteCommand
  /** URI factory; absent uses `vscode.Uri.file`. */
  readonly toUri?: (path: string) => vscode.Uri
}

/**
 * Install one verified VSIX and reload the window.
 *
 * The install command receives a file URI, which is the form that installs from a local package; a boolean result of
 * `false` and a rejected command are both reported as a failed install, and neither reaches the reload. Only after the
 * install command settles does the reload run, because reloading first would discard the staged file's install.
 * @param options - the verified file, the running-work guard, and the confirmation and command surfaces.
 * @returns the installed version, or the condition that stopped the install and what remains true afterwards.
 */
export async function installStagedUpdate(options: InstallStagedUpdateOptions): Promise<InstallOutcome> {
  const log = options.log ?? (() => {})
  const execute = options.executeCommand ?? ((command, ...args) => vscode.commands.executeCommand(command, ...args))
  const toUri = options.toUri ?? ((path: string) => vscode.Uri.file(path))

  let work: readonly string[]
  try {
    work = await options.guard.blockers()
  } catch (error) {
    // The monitor could not establish the work, so it is unknown rather than absent and the user decides.
    work = [`a running turn this window cannot query (${describeUpdateError(error)})`]
  }
  if (work.length > 0) {
    const accepted = await options.confirm({ version: options.version, work })
    if (!accepted) {
      const detail = `DSH ${options.version} was not installed because ${work.join(', ')} is running`
      log(`dsh: ${detail}`)
      return { ok: false, code: 'work-running', detail }
    }
  }

  log(`dsh: installing DSH ${options.version} from ${options.path}`)
  try {
    const result = await execute('workbench.extensions.installExtension', toUri(options.path))
    if (result === false) {
      return { ok: false, code: 'install-failed', detail: 'VS Code refused the extension installation' }
    }
  } catch (error) {
    return {
      ok: false,
      code: 'install-failed',
      detail: `VS Code could not install the extension: ${describeUpdateError(error)}`,
    }
  }

  if (options.handover !== undefined) {
    // The installed package replaced the directory the running host was
    // launched from. Stop that host before the reload so the window that comes
    // back cannot attach to a process reading removed files.
    log(`dsh: stopping the DSH host that ran DSH ${options.version} before the window reload`)
    try {
      await options.handover()
    } catch (error) {
      return {
        ok: false,
        code: 'handover-failed',
        detail: `DSH ${options.version} is installed, but the previous DSH host did not stop (${describeUpdateError(error)}); stop it and reload the window to use the new version`,
      }
    }
  }

  try {
    await execute('workbench.action.reloadWindow')
  } catch (error) {
    return {
      ok: false,
      code: 'reload-failed',
      detail: `DSH ${options.version} is installed, but the window did not reload: ${describeUpdateError(error)}`,
    }
  }
  log(`dsh: DSH ${options.version} was installed and the window reload was requested`)
  return { ok: true, version: options.version }
}
