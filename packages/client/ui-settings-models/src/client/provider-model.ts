/**
 * The carrier hook that saves the deployment-owned route's model id.
 *
 * A carrier that provisions a route in a launch overlay (the VS Code extension)
 * installs `setProviderModel` on the page transport. The hook writes the
 * carrier's deployment setting and answers saved or failed; it does not write
 * the DSH profile, because the overlay replaces that route's profile values on
 * the next launch. A served page has no hook, so the Models page keeps the
 * deployment route's discovery listing read-only there.
 */

/** What one save request settled as. */
export type ProviderModelSave =
  /** The carrier stored the model id; the next launch reads it. */
  | { readonly kind: 'saved' }
  /** The carrier refused or failed the save, with its own message when it reported one. */
  | { readonly kind: 'failed'; readonly detail: string }

/** The carrier hook, as the page transport exposes it. */
interface ProviderModelTransport {
  setProviderModel?: unknown
}

/**
 * Read the carrier's deployment-model save hook, when the page transport carries one.
 * @returns the save request, or undefined for a page whose carrier has none.
 */
export function providerModelSaver(): ((model: string) => Promise<ProviderModelSave>) | undefined {
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: ProviderModelTransport
  }).__DSH_TRANSPORT__
  const hook = transport?.setProviderModel
  if (typeof hook !== 'function') return undefined
  return async (model: string) => {
    try {
      return readSaveAnswer(await (hook as (model: string) => Promise<unknown>)(model))
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Validate one carrier answer before the page reports the model as saved.
 * @param value - the answer the page transport resolved.
 * @returns the settled save; an unreadable answer is a failure, never a save.
 */
function readSaveAnswer(value: unknown): ProviderModelSave {
  // The Webview carrier resolves without a value once it wrote the setting.
  if (value === undefined) return { kind: 'saved' }
  if (typeof value !== 'object' || value === null) return { kind: 'failed', detail: '' }
  const answer = value as { ok?: unknown; error?: unknown }
  if (answer.ok === true) return { kind: 'saved' }
  if (answer.ok === false) return { kind: 'failed', detail: typeof answer.error === 'string' ? answer.error : '' }
  return { kind: 'failed', detail: '' }
}
