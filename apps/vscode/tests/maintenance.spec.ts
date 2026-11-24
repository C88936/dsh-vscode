/**
 * Host-wide maintenance admission: a module operation holds the gate for every
 * window, turns are refused while it runs, and an operation waits for the one
 * before it instead of running concurrently.
 */
import { describe, expect, it } from 'vitest'
import { MaintenanceGate, withMaintenanceGate } from '../src/companion/maintenance.ts'
import { preStepDecision } from '../src/companion/admission.ts'
import type { HostConnection, HostSession } from '../src/companion/server.ts'

/** One decoded Webview fetch frame calling a Remote method. */
function fetchFrame(method: string, id: number): unknown {
  return { type: 'fetch', id, body: JSON.stringify({ method, arguments: {} }) }
}

/** One connection that records every frame the host wrote. */
function connection(sent: unknown[]): HostConnection {
  return { id: 'connection-1', send: (frame) => { sent.push(frame) }, close: () => {} }
}

/**
 * @param onFetch - called for every fetch frame the transport accepts.
 * @returns a session that records handled methods.
 */
function session(onFetch?: (method: string, frame: unknown) => Promise<void>): HostSession & { handled: string[] } {
  const handled: string[] = []
  return {
    handled,
    ready: {},
    handle: async (frame: unknown) => {
      const body = JSON.parse((frame as { body: string }).body) as { method: string }
      handled.push(body.method)
      await onFetch?.(body.method, frame)
    },
    dispose: async () => {},
  }
}

/**
 * @param activity - running work the gate reports.
 * @returns the gate and the frame sink of one connection.
 */
function gateFor(activity: { runningTurns: number; packageOperations: number; runningTerminals: number }) {
  const gate = new MaintenanceGate({ activity: () => activity, log: () => {} })
  const sent: unknown[] = []
  return { gate, sent, gated: connection(sent) }
}

describe('MaintenanceGate', () => {
  it('refuses a module operation while a turn is running, then reopens', async () => {
    const activity = { runningTurns: 1, packageOperations: 0, runningTerminals: 0 }
    const { gate, sent, gated } = gateFor(activity)
    const inner = session()
    const gatedSession = withMaintenanceGate(inner, gated, gate)

    await gatedSession.handle(fetchFrame('pluginManager/installBundle', 1))
    expect(inner.handled).toEqual([])
    const refusal = sent[0] as { status: number; body: string }
    expect(refusal.status).toBe(409)
    const body = JSON.parse(refusal.body) as {
      result: { ok: boolean; error: { code: string; message: string } }
    }
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('plugin-manager/maintenance-busy')
    expect(body.result.error.message).toContain('running turn')
    expect(gate.inMaintenance).toBe(false)

    // Once the turn ends the same operation is admitted.
    activity.runningTurns = 0
    const admitted = session()
    await withMaintenanceGate(admitted, gated, gate).handle(fetchFrame('pluginManager/installBundle', 2))
    expect(admitted.handled).toEqual(['pluginManager/installBundle'])
  })

  it('names the running Sessions in a refusal', async () => {
    const gate = new MaintenanceGate({
      activity: () => ({ runningTurns: 1, packageOperations: 0, runningTerminals: 0 }),
      runningSessions: () => ['session-1', 'session-2'],
      log: () => {},
    })
    const sent: unknown[] = []
    const gated = connection(sent)
    await withMaintenanceGate(session(), gated, gate).handle(fetchFrame('pluginManager/installBundle', 30))
    const body = JSON.parse((sent[0] as { body: string }).body) as {
      result: { error: { message: string } }
    }
    expect(body.result.error.message).toContain('Running sessions: session-1, session-2.')
  })

  it('blocks window and Host turns until the disconnected install finishes without a reply', async () => {
    const { gate, gated } = gateFor({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 })
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const installer = withMaintenanceGate(session(async () => {
      started.resolve()
      await finish.promise
    }), gated, gate)
    const sent: unknown[] = []
    const other = session()
    const observer = withMaintenanceGate(other, { ...connection(sent), id: 'connection-2' }, gate)
    const enter = async () => ({ kind: 'enter' as const, messages: [] })
    const operation = installer.handle(fetchFrame('pluginManager/installBundle', 10))
    await started.promise
    await installer.dispose()
    await observer.handle(fetchFrame('session/prompt', 11))
    expect(sent).toEqual([expect.objectContaining({ id: 11, status: 409 })])
    expect(other.handled).toEqual([])
    await expect(preStepDecision(gate, enter)).resolves.toEqual({ kind: 'reject' })
    finish.resolve()
    await operation
    await observer.handle(fetchFrame('session/prompt', 12))
    expect(other.handled).toEqual(['session/prompt'])
    await expect(preStepDecision(gate, enter)).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('skips queued changes from a window that disconnected before admission', async () => {
    const { gate, gated } = gateFor({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 })
    const release = await gate.acquire()
    const inner = session()
    const queued = withMaintenanceGate(inner, gated, gate)
    const operation = queued.handle(fetchFrame('pluginManager/removeBundle', 1))
    await queued.dispose()
    release()
    await operation
    expect(inner.handled).toEqual([])
    expect(gate.inMaintenance).toBe(false)
  })

  it('serializes two module operations', async () => {
    const { gate, gated } = gateFor({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 })
    const finishes: (() => void)[] = []
    const order: string[] = []
    const inner = session(async (method) => {
      order.push(method)
      await new Promise<void>((resolve) => { finishes.push(resolve) })
    })
    const gatedSession = withMaintenanceGate(inner, gated, gate)

    const first = gatedSession.handle(fetchFrame('pluginManager/installBundle', 20))
    const second = gatedSession.handle(fetchFrame('pluginManager/removeBundle', 21))
    await Promise.resolve()
    await Promise.resolve()
    // The second operation waits for the first one's result.
    expect(order).toEqual(['pluginManager/installBundle'])
    finishes[0]?.()
    await first
    await Promise.resolve()
    expect(order).toEqual(['pluginManager/installBundle', 'pluginManager/removeBundle'])
    finishes[1]?.()
    await second
    expect(gate.inMaintenance).toBe(false)
  })
})
