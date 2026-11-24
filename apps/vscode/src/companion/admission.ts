/**
 * Host-wide turn admission while a shared host is entering maintenance.
 *
 * The plugin-manager gate refuses a prompt the moment maintenance starts, but a
 * turn can also begin inside the host — a queued follow-up, a subagent
 * settlement, a scheduled round, a resend. Those never pass through the
 * Webview transport, so the host rejects their first model step instead: the
 * loop ends the turn as blocked with a visible message rather than running it
 * while the host is being replaced.
 *
 * @module @deepseek-ai/dsh-vscode/companion/admission
 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'

/** Read-only view of the shared Host's maintenance gate. */
export interface TurnAdmission {
  /** Whether a plugin operation or restart currently holds the gate. */
  readonly inMaintenance: boolean
}

/**
 * Choose the pre-step answer for one host.
 *
 * Exported alone so the decision is testable without an application context;
 * the loop treats a rejected step as `blocked` without a model request.
 * @param admission - the host's admission state.
 * @param next - the remaining pre-step chain.
 * @returns the rejection while admission is closed, otherwise the chain's answer.
 */
export function preStepDecision(
  admission: TurnAdmission,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  return admission.inMaintenance ? Promise.resolve({ kind: 'reject' }) : next()
}

/**
 * Reject every model step while maintenance has closed admission.
 *
 * Registered as a Loader plugin so the listener belongs to the application
 * tree and unwinds with it.
 */
export const MaintenanceAdmission: Plugin.Object<{ readonly admission: TurnAdmission }> = {
  name: 'vscode-maintenance-admission',
  apply(ctx: Context, config): void {
    ctx.on('agent/pre-step', (_payload, next) => preStepDecision(config.admission, next))
  },
}
