/**
 * Native file-or-folder selection for the Plugins page.
 *
 * The DSH client runs inside the Webview, where no operating-system dialog is
 * reachable; the Plugins page therefore asks the extension host for one local
 * path and feeds it into the existing inspect/install flow. The two selection
 * kinds are separate requests because a native Windows dialog cannot offer
 * files and folders at once. Only a companion-local file is accepted: a
 * selection outside the `file:` scheme comes from a remote or virtual file
 * system the companion does not run on, so it is refused rather than turned
 * into a local-looking path.
 * @module @deepseek-ai/dsh-vscode/host/local-path-picker
 */

/** Archive extensions the package manager installs as a tarball spec. */
const PLUGIN_ARCHIVES = ['tgz', 'tar.gz']

/** The selection a Webview asks for: one archive file, or one package directory. */
export type PickLocalPathKind = 'file' | 'folder'

/** A selection the webview can ask the extension host to open. */
export interface PickLocalPathMessage {
  readonly type: 'pick-local-path'
  readonly id: number
  readonly kind: PickLocalPathKind
}

/** Why the extension host returned no path. */
export type PickLocalPathFailure = 'cancelled' | 'unsupported' | 'failed'

/** The answer the webview receives for one selection request. */
export interface PickLocalPathResult {
  readonly type: 'pick-result'
  readonly id: number
  /** The selected companion-local absolute path. */
  readonly path?: string
  readonly reason?: PickLocalPathFailure
  /** What the dialog reported when it failed; empty for a refusal this adapter states itself. */
  readonly detail?: string
}

/** One selected resource, as this adapter reads it. */
export interface PickedUri {
  readonly scheme: string
  readonly authority: string
  readonly fsPath: string
}

/** What the dialog is asked for: one existing package directory or archive. */
export interface PickDirectoryOptions {
  readonly canSelectFiles: boolean
  readonly canSelectFolders: boolean
  readonly canSelectMany: false
  readonly openLabel: string
  readonly filters?: Record<string, string[]>
}

/** The extension-host surface this adapter uses. */
export interface PickDialogHost {
  /**
   * @param options - one selection dialog.
   * @returns the selected resources, or undefined when the operator cancelled.
   */
  showOpenDialog(options: PickDirectoryOptions): PromiseLike<readonly PickedUri[] | undefined>
}

/**
 * Whether one Webview message asks for a native selection.
 * @param value - decoded message from the Webview.
 * @returns whether the message is a well-formed selection request.
 */
export function isPickLocalPathMessage(value: unknown): value is PickLocalPathMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; id?: unknown; kind?: unknown }
  return message.type === 'pick-local-path' && typeof message.id === 'number' && Number.isInteger(message.id)
    && (message.kind === 'file' || message.kind === 'folder')
}

/**
 * Open the selection dialog for one kind and describe its outcome.
 * @param host - the extension-host dialog.
 * @param request - the validated Webview request.
 * @returns the path to install from, or why no path was returned.
 */
export async function pickLocalPath(host: PickDialogHost, request: PickLocalPathMessage): Promise<PickLocalPathResult> {
  const archive = request.kind === 'file'
  let selected: readonly PickedUri[] | undefined
  try {
    selected = await host.showOpenDialog({
      canSelectFiles: archive,
      canSelectFolders: !archive,
      canSelectMany: false,
      openLabel: 'Choose for the DSH plugin install',
      ...archive ? { filters: { 'Plugin archive': [...PLUGIN_ARCHIVES] } } : {},
    })
  } catch (error) {
    return { type: 'pick-result', id: request.id, reason: 'failed', detail: messageOf(error) }
  }
  const uri = selected?.[0]
  if (uri === undefined) return { type: 'pick-result', id: request.id, reason: 'cancelled' }
  // A remote or virtual file system is not the companion's own disk, so its path cannot install a package here.
  if (uri.scheme !== 'file' || uri.fsPath === '') return { type: 'pick-result', id: request.id, reason: 'unsupported' }
  return { type: 'pick-result', id: request.id, path: uri.fsPath }
}

/**
 * @param error - thrown value.
 * @returns a single-line description.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
