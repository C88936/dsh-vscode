/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
  /**
   * Route id a carrier provisions in a launch overlay. The Models page renders
   * that route's endpoint, served model, and model limits read-only and names
   * the settings that own them. Every other route, including a hand-declared
   * one, keeps its profile fields and model list editable. Absent means no
   * route is deployment-owned.
   */
  deploymentOwnedRoute?: string
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
  deploymentOwnedRoute: z.string(),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
