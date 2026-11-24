/**
 * Status bar text for the running application's deployment model.
 *
 * Kept free of the VS Code API so the mapping is testable on its own.
 * @module @deepseek-ai/dsh-vscode/shared/model-status
 */
import type { HostModelConfig } from './host-protocol.ts'

/**
 * Status bar text naming the running application's deployment model.
 *
 * A window whose saved settings differ still shows what the shared host
 * actually runs, with the difference named instead of hidden.
 * @param config - deployment model configuration the host answered with.
 * @param mismatch - whether this window saves different deployment settings.
 * @returns the text to show in the status bar.
 */
export function modelStatusText(config: HostModelConfig, mismatch: boolean): string {
  const suffix = mismatch ? ' (this window differs)' : ''
  if (!config.configured) return `DSH: no model configured${suffix}`
  const label = config.model === '' ? config.provider : `${config.provider}/${config.model}`
  return `DSH: ${label}${suffix}`
}
