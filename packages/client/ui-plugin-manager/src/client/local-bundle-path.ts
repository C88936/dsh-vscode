/**
 * The carrier's native archive-or-folder chooser for a prepared plugin bundle.
 *
 * A shell that owns a native dialog (the VS Code extension) installs the
 * `pickLocalBundlePath` page-transport hook; a served page has none, so its
 * install dialog offers no chooser and keeps the typed spec. The hook answers
 * with the selected local absolute path, a cancellation, or a refusal the page
 * reports as localized copy.
 */

/** What the carrier is asked to select. */
export type LocalBundleKind = 'file' | 'folder'

/** What one chooser request settled as. */
export type LocalBundlePick =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly detail: string }

/** The carrier hook, as the page transport exposes it. */
interface LocalBundlePickerTransport {
  pickLocalBundlePath?: unknown
}

/**
 * Read the carrier's chooser, when the page transport carries one.
 * @returns the request by selection kind, or undefined for a page whose carrier cannot open a dialog.
 */
export function localBundlePicker(): ((kind: LocalBundleKind) => Promise<LocalBundlePick>) | undefined {
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: LocalBundlePickerTransport
  }).__DSH_TRANSPORT__
  const hook = transport?.pickLocalBundlePath
  if (typeof hook !== 'function') return undefined
  return async (kind: LocalBundleKind) => readPick(await (hook as (kind: LocalBundleKind) => Promise<unknown>)(kind))
}

/**
 * Validate one carrier answer before the dialog acts on it.
 * @param value - the answer the page transport resolved.
 * @returns the settled pick; an unreadable answer fails rather than picking.
 */
function readPick(value: unknown): LocalBundlePick {
  if (typeof value !== 'object' || value === null) return { kind: 'failed', detail: '' }
  const answer = value as { path?: unknown; reason?: unknown; detail?: unknown }
  if (typeof answer.path === 'string' && answer.path !== '') return { kind: 'picked', path: answer.path }
  if (answer.reason === 'cancelled' || answer.reason === 'unsupported') return { kind: answer.reason }
  return { kind: 'failed', detail: typeof answer.detail === 'string' ? answer.detail : '' }
}
