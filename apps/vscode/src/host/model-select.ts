/**
 * Company model discovery and selection before a first send.
 *
 * The company setup collects the endpoint; this step lists the models that
 * endpoint serves and saves the chosen id, so a fresh deployment reaches a
 * usable model without the user editing settings by hand.
 * @module @deepseek-ai/dsh-vscode/host/model-select
 */

/**
 * Model ids from one OpenAI-compatible `/models` response.
 *
 * Accepts `{ data: [{ id }] }` (the OpenAI shape) and a bare array of ids so a
 * gateway with a minimal models endpoint still works. Ids are trimmed, deduped,
 * and sorted; entries without a usable id are skipped.
 * @param payload - decoded JSON response.
 * @returns every usable model id.
 */
export function parseModelIds(payload: unknown): string[] {
  const entries = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : []
  const ids = new Set<string>()
  for (const entry of entries) {
    const id = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id
        : undefined
    const trimmed = id?.trim()
    if (trimmed !== undefined && trimmed !== '') ids.add(trimmed)
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}

/**
 * List the models a company endpoint serves.
 *
 * The request is a plain `GET <base>/models` with the stored key as a bearer
 * credential. A non-success status, a body that is not JSON, or a response that
 * lists no model is reported as a failure with the status or a short reason.
 * @param baseUrl - Chat Completions base URL, such as `http://llm.lan:8000/v1`.
 * @param apiKey - stored endpoint key, when one exists.
 * @param implementation - fetch implementation; defaults to the global one.
 * @param timeoutMs - how long the endpoint has to answer.
 * @returns the model ids the endpoint listed.
 * @throws when the endpoint cannot be reached, rejects, or lists no usable model.
 */
export async function fetchCompanyModels(
  baseUrl: string,
  apiKey: string | undefined,
  implementation: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  let response: Response
  try {
    response = await implementation(url, {
      headers: apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`the endpoint could not be reached (${describe(error)})`)
  }
  if (!response.ok) throw new Error(`the endpoint answered HTTP ${String(response.status)}`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`the endpoint did not return JSON (${describe(error)})`)
  }
  const models = parseModelIds(payload)
  if (models.length === 0) throw new Error('the endpoint listed no model')
  return models
}

/** Inputs for one model selection. */
export interface ModelSelectionRequest {
  /** Endpoint root the models are listed from. */
  readonly baseUrl: string
  /** Stored endpoint key, when one exists. */
  readonly readKey: () => Promise<string | undefined>
  /** Lists models for the endpoint; injectable for tests. */
  readonly listModels: (baseUrl: string, apiKey: string | undefined) => Promise<string[]>
  /** Model id the deployment currently saves. */
  readonly currentModel: string
  /** Asks the user to choose one model; `undefined` means the user cancelled. */
  readonly pickModel: (models: readonly string[], current: string) => Promise<string | undefined>
  /** Saves the chosen model. */
  readonly saveModel: (model: string) => Promise<void>
  /** Confirms that the host must restart to use the model; resolves whether it should restart now. */
  readonly confirmRestart: (model: string) => Promise<boolean>
  /** Diagnostic sink. */
  readonly log: (line: string) => void
}

/** What one selection established. */
export type ModelSelectionOutcome =
  | { readonly status: 'saved'; readonly model: string; readonly restart: boolean }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly diagnostic: string }

/**
 * List the endpoint's models, let the user choose one, and save the choice.
 *
 * A cancelled pick leaves the saved model untouched. Saving reports success
 * even when the user declines the immediate restart: the model is saved for the
 * next start, and the caller shows the saved-but-not-running state.
 * @param request - endpoint, callbacks, and diagnostic sink.
 * @returns what the selection established.
 */
export async function selectCompanyModel(request: ModelSelectionRequest): Promise<ModelSelectionOutcome> {
  const apiKey = await request.readKey()
  let models: string[]
  try {
    models = await request.listModels(request.baseUrl, apiKey)
  } catch (error) {
    const diagnostic = `DSH could not list models from ${request.baseUrl}: ${describe(error)}`
    request.log(`dsh: ${diagnostic}`)
    return { status: 'failed', diagnostic }
  }
  const picked = await request.pickModel(models, request.currentModel)
  if (picked === undefined) return { status: 'cancelled' }
  try {
    await request.saveModel(picked)
  } catch (error) {
    const diagnostic = `DSH could not save the model selection: ${describe(error)}`
    request.log(`dsh: ${diagnostic}`)
    return { status: 'failed', diagnostic }
  }
  request.log(`dsh: the company model selection is now ${picked}`)
  const restart = await request.confirmRestart(picked)
  return { status: 'saved', model: picked, restart }
}

/**
 * @param error - thrown value.
 * @returns a short message for a diagnostic.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
