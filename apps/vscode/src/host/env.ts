/**
 * Launch environment assembled from VS Code-owned secrets and settings.
 *
 * The extension never writes a provider key into the Harness home: it stays in
 * VS Code's `SecretStorage` and reaches DSH only as launch environment values,
 * which is the same layer `.env` files and the CLI populate. The harness
 * credential service checks its managed credentials document (written by the
 * DSH Models page) before this launch fallback, so removing a `SecretStorage`
 * item removes only that item: a managed credential, an environment value, or a
 * `.env` entry may still resolve the route, and this module checks none of them.
 * @module @deepseek-ai/dsh-vscode/host/env
 */
import { createHash } from 'node:crypto'

/** Launch variable carrying the public DeepSeek provider key. */
export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** SecretStorage key holding the DeepSeek API key. */
export const API_KEY_SECRET = 'dsh.deepseekApiKey'

/** Legacy SecretStorage key holding an unscoped private endpoint key. */
export const LLM_KEY_SECRET = 'dsh.llmApiKey'

/**
 * @param baseUrl - company endpoint configured in this window.
 * @returns the SecretStorage slot for keys entered for that endpoint.
 */
export function companyKeySlot(baseUrl: string): string {
  const endpoint = baseUrl.trim().replace(/\/+$/u, '')
  return `${LLM_KEY_SECRET}.${createHash('sha256').update(endpoint).digest('hex')}`
}

/** Credential values the extension hands to the application. */
export interface LaunchCredentials {
  /** Private endpoint key, from SecretStorage. */
  readonly llmApiKey?: string
  /** Provider API key, from `SecretStorage`. */
  readonly apiKey?: string
  /** Messages-compatible base URL, from the `dsh.apiBaseUrl` setting. */
  readonly baseUrl?: string
}

/**
 * Convert credentials to the variables the DSH LLM adapter reads.
 * @param credentials - configured credentials.
 * @returns environment entries for the launch snapshot; empty when unset.
 */
export function credentialEnv(credentials: LaunchCredentials): Record<string, string> {
  return {
    ...credentials.apiKey === undefined || credentials.apiKey === '' ? {} : { [DEEPSEEK_API_KEY_ENV]: credentials.apiKey },
    ...credentials.baseUrl === undefined || credentials.baseUrl === '' ? {} : { DEEPSEEK_BASE_URL: credentials.baseUrl },
  }
}
