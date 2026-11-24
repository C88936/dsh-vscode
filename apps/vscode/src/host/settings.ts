/**
 * Provider routing, deployment limits, and selected-provider credential state.
 *
 * One owner per company value: the endpoint URL, the model id that endpoint
 * serves, the credential reference, and the default model an Agent uses are
 * deployment-owned and reach the application through the generated launch
 * overlay. The key stays in VS Code `SecretStorage` with the harness
 * managed-credential fallback intact.
 * @module @deepseek-ai/dsh-vscode/host/settings
 */
import { DEEPSEEK_API_KEY_ENV, type LaunchCredentials } from './env.ts'
import type { HostModelConfig } from '../shared/host-protocol.ts'

/** Provider shape selected in settings. */
export type ProviderMode = 'deepseek' | 'openai-compatible'

/** Settings the extension reads for provider routing. */
export interface ProviderSettings {
  /** Selected provider shape. */
  readonly mode: ProviderMode
  /** Route name the composition selects. */
  readonly route: string
  /** Chat Completions root of a private deployment. */
  readonly baseUrl: string
  /** Model id served by that route. */
  readonly model: string
  /** Environment name carrying the private key. */
  readonly apiKeyEnv: string
  /** Context window declared for the route's model; unset keeps the adapter default. */
  readonly contextWindow?: number
  /** Output-token cap declared for the route's model; unset keeps the adapter default. */
  readonly maxTokens?: number
}

/** Defaults used when a setting is empty. */
export const PROVIDER_DEFAULTS = {
  route: 'company',
  apiKeyEnv: 'DSH_LLM_API_KEY',
} as const

/**
 * Model id the launch overlay pins while the deployment has not chosen a model.
 *
 * A company first-run setup collects the endpoint before any model is known.
 * Pinning this id lets the application boot and the Models page run endpoint
 * discovery, which is the step that produces the real model. No endpoint serves
 * this id: it is not usable for inference, and the Models-page carrier hook
 * refuses it so the placeholder cannot be saved as a choice.
 */
export const UNCONFIGURED_MODEL_ID = 'dsh-unconfigured-model'

/** Largest model id accepted for the deployment route. */
export const MAX_MODEL_ID_LENGTH = 200

/**
 * Report why one typed company endpoint cannot be stored.
 *
 * The generated launch overlay and the first-run setup command share this check
 * so a URL the settings accept cannot fail later at overlay generation.
 * @param value - base URL as typed or configured.
 * @returns the reason, or undefined when the value is an HTTP(S) base URL without embedded credentials.
 */
export function companyBaseUrlError(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return 'the endpoint URL is empty'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return `the endpoint URL is not a URL: ${JSON.stringify(trimmed)}`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'the endpoint URL must be http or https'
  if (parsed.username !== '' || parsed.password !== '') {
    return 'the endpoint URL must not embed credentials; store the key with DSH: Set Private Endpoint API Key'
  }
  return undefined
}

/**
 * Report why one model id cannot be saved for the deployment route.
 *
 * The Models page supplies this value from an endpoint listing, so it is
 * checked before it reaches `dsh.llmModel`: the stored value becomes a YAML
 * model entry and the agent default on the next launch.
 * @param value - model id as typed, listed, or configured.
 * @returns the reason, or undefined when the id may be saved.
 */
export function providerModelIdError(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return 'the model id is empty'
  if (trimmed.length > MAX_MODEL_ID_LENGTH) {
    return `the model id is longer than ${String(MAX_MODEL_ID_LENGTH)} characters`
  }
  // A newline or other control character would reach the generated YAML and
  // the request body as text the endpoint never disclosed.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return 'the model id contains a control character'
  if (trimmed === UNCONFIGURED_MODEL_ID) {
    return 'that is the unconfigured placeholder, not a model the endpoint serves'
  }
  return undefined
}

/**
 * Environment entries for the private endpoint key.
 *
 * A managed credential written by the Models page outranks this launch value,
 * so a missing SecretStorage key does not prove the route has no credential.
 * @param settings - provider settings; the key name comes from `apiKeyEnv`.
 * @param credentials - stored credentials.
 * @returns the environment entries, empty when no key is stored.
 */
export function providerEnv(settings: ProviderSettings, credentials: LaunchCredentials): Record<string, string> {
  const key = credentials.llmApiKey
  return key === undefined || key === '' ? {} : { [settings.apiKeyEnv]: key }
}

/**
 * Deployment model configuration the application boots with.
 *
 * The company route is the only one whose model the deployment selects; the
 * official route carries the application's own default, which this extension
 * does not name. A company route without a model boots with the placeholder
 * gate, so it is reported as not configured rather than as a usable route.
 * @param settings - provider settings the application launches with.
 * @returns route, model, and whether the application has a usable model.
 */
export function launchModelConfig(settings: ProviderSettings): HostModelConfig {
  return settings.mode === 'deepseek'
    ? { provider: 'deepseek-official', model: '', configured: true }
    : { provider: settings.route, model: settings.model, configured: settings.model.trim() !== '' }
}

/**
 * Deployment field the company route still needs.
 *
 * `endpoint` is `dsh.llmBaseUrl`, `model` is `dsh.llmModel`, and `key` is the
 * private endpoint key stored in VS Code `SecretStorage`. The active model
 * selection is profile-owned and is not part of this list.
 */
export type CompanySetupField = 'endpoint' | 'model' | 'key'

/** Whether `SecretStorage` carries the company endpoint's optional key. */
export type CompanyCredentialState = 'stored' | 'not-stored'

/** Deployment fields an OpenAI-compatible route still lacks. */
export interface CompanySetupStatus {
  /** Missing required fields, in setup order: the endpoint and the model. */
  readonly missing: readonly CompanySetupField[]
  /** Whether the optional endpoint key is stored; absence does not make the setup incomplete. */
  readonly credential: CompanyCredentialState
  /** Whether every deployment field this extension requires is present. */
  readonly complete: boolean
}

/**
 * Report the deployment fields an OpenAI-compatible route still lacks.
 *
 * The endpoint key is optional: a company gateway may not require authentication, and this extension cannot tell
 * from settings alone whether it does. A missing key is therefore reported separately as `not-stored` rather than
 * as a missing field, so first-run setup can finish and discovery can report a 401 if the gateway needs one.
 * @param settings - provider settings.
 * @param credentials - stored credentials.
 * @returns the missing required fields, the optional key state, and whether the route is complete.
 */
export function companySetupStatus(settings: ProviderSettings, credentials: LaunchCredentials): CompanySetupStatus {
  const missing: CompanySetupField[] = []
  if (settings.baseUrl === '') missing.push('endpoint')
  if (settings.model.trim() === '') missing.push('model')
  const stored = credentials.llmApiKey !== undefined && credentials.llmApiKey !== ''
  return { missing, credential: stored ? 'stored' : 'not-stored', complete: missing.length === 0 }
}

/** Stored credential state of the selected provider shape. */
export interface ProviderKeyState {
  /** Environment name the selected route resolves. */
  readonly envName: string
  /** Whether VS Code `SecretStorage` holds a value under that environment name. */
  readonly stored: boolean
}

/**
 * Report the selected provider's `SecretStorage` key, never both stored keys.
 * @param settings - provider settings selecting the route.
 * @param credentials - stored credentials.
 * @returns the selected credential's environment name and storage presence.
 */
export function selectedProviderKey(settings: ProviderSettings, credentials: LaunchCredentials): ProviderKeyState {
  const deepseek = settings.mode === 'deepseek'
  const key = deepseek ? credentials.apiKey : credentials.llmApiKey
  return {
    envName: deepseek ? DEEPSEEK_API_KEY_ENV : settings.apiKeyEnv,
    stored: key !== undefined && key !== '',
  }
}

/**
 * Settings the companion reads once at launch. A saved change to any of them
 * only reaches the running host after `DSH: Restart Host`.
 */
const LAUNCH_PROVIDER_SETTINGS = [
  'providerMode',
  'providerRoute',
  'llmBaseUrl',
  'llmModel',
  'llmApiKeyEnv',
  'llmContextWindow',
  'llmMaxTokens',
] as const

/**
 * Name the launch settings whose saved value differs from the running host.
 * @param active - provider settings the running host launched with.
 * @param saved - provider settings currently saved in VS Code.
 * @returns `dsh.<name>` for each changed setting, in launch order.
 */
export function changedProviderSettings(active: ProviderSettings, saved: ProviderSettings): string[] {
  const differs: Record<(typeof LAUNCH_PROVIDER_SETTINGS)[number], boolean> = {
    providerMode: active.mode !== saved.mode,
    providerRoute: active.route !== saved.route,
    llmBaseUrl: active.baseUrl !== saved.baseUrl,
    llmModel: active.model !== saved.model,
    llmApiKeyEnv: active.apiKeyEnv !== saved.apiKeyEnv,
    llmContextWindow: active.contextWindow !== saved.contextWindow,
    llmMaxTokens: active.maxTokens !== saved.maxTokens,
  }
  return LAUNCH_PROVIDER_SETTINGS.filter(setting => differs[setting]).map(setting => `dsh.${setting}`)
}
