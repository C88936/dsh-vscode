/**
 * Maintenance admission for turns that start inside the shared host: a closed
 * gate rejects the model step (the loop ends the turn as blocked) and an open
 * one delegates to the rest of the pre-step chain.
 */
import { describe, expect, it } from 'vitest'
import { preStepDecision } from '../src/companion/admission.ts'

/** The chain answer one accepted step produces. */
const ENTER = { kind: 'enter' as const, messages: [] }

describe('TurnAdmission', () => {
  it('rejects every model step while closed and delegates again after reopening', async () => {
    const admission = { inMaintenance: false }
    const next = async () => ENTER

    await expect(preStepDecision(admission, next)).resolves.toEqual(ENTER)
    admission.inMaintenance = true
    await expect(preStepDecision(admission, next)).resolves.toEqual({ kind: 'reject' })
    admission.inMaintenance = false
    await expect(preStepDecision(admission, next)).resolves.toEqual(ENTER)
  })

  it('does not call the chain while closed', async () => {
    const admission = { inMaintenance: true }
    let calls = 0
    await preStepDecision(admission, async () => {
      calls += 1
      return ENTER
    })
    expect(calls).toBe(0)
  })
})
