/**
 * Companion activity query: the counts the extension's restart check receives name the work this process really
 * owns, and a service the composition does not mount contributes nothing.
 */
import { describe, expect, it } from 'vitest'
import { hostActivity, withHostControl } from '../src/companion/activity.ts'
import type { HostConnection, HostSession } from '../src/companion/server.ts'

/** One live Agent double. */
interface AgentDouble {
  readonly status: string
}

/** One terminal double, keyed by the Agent it belongs to. */
interface TerminalDouble {
  readonly status: { readonly kind: string }
}

/**
 * @param services - services the fake context exposes.
 * @returns a service lookup over them.
 */
function lookup(services: Record<string, unknown>): (name: string) => unknown {
  return name => services[name]
}

describe('hostActivity', () => {
  it('counts running turns, running terminals per Agent, and unsettled package operations', () => {
    const running: AgentDouble = { status: 'running' }
    const idle: AgentDouble = { status: 'idle' }
    const terminals = new Map<AgentDouble, TerminalDouble[]>([
      [running, [{ status: { kind: 'running' } }, { status: { kind: 'exited' } }]],
      [idle, [{ status: { kind: 'running' } }]],
    ])
    const get = lookup({
      agents: { list: () => [running, idle] },
      terminals: { list: (agent: AgentDouble) => terminals.get(agent) ?? [] },
    })
    expect(hostActivity(get, new Set(['install-1', 'install-2']))).toEqual({
      runningTurns: 1,
      packageOperations: 2,
      runningTerminals: 2,
    })
  })

  it('reports no work when the composition mounts neither service', () => {
    expect(hostActivity(lookup({}), new Set())).toEqual({
      runningTurns: 0,
      packageOperations: 0,
      runningTerminals: 0,
    })
  })

  it('counts turns without terminals when the terminals service is absent', () => {
    const get = lookup({ agents: { list: () => [{ status: 'running' }] } })
    expect(hostActivity(get, new Set())).toEqual({
      runningTurns: 1,
      packageOperations: 0,
      runningTerminals: 0,
    })
  })
})

describe('withHostControl maintenance answer', () => {
  /** A connection that records what the host wrote. */
  function connection(sent: unknown[]): HostConnection {
    return { id: 'connection-1', send: (frame) => { sent.push(frame) }, close: () => {} }
  }

  /** A session that records nothing and answers nothing. */
  const session: HostSession = { ready: {}, handle: async () => {}, dispose: async () => {} }

  it('waits for an asynchronous answer before writing it', async () => {
    const sent: unknown[] = []
    let release: (() => void) | undefined
    const controlled = withHostControl(session, connection(sent), {
      activity: () => ({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 }),
      shutdown: async () => await new Promise((resolve) => {
        release = () => { resolve({ ok: false, error: 'DSH still reports 1 running turn.' }) }
      }),
    })
    const pending = controlled.handle({ type: 'host-shutdown', id: 3 })
    // Nothing is written until the host has decided whether it can stop.
    expect(sent).toEqual([])
    release?.()
    await pending
    expect(sent).toEqual([{ type: 'host-shutdown-result', id: 3, ok: false, error: 'DSH still reports 1 running turn.' }])
  })

  it('still answers a synchronous refusal', async () => {
    const sent: unknown[] = []
    const controlled = withHostControl(session, connection(sent), {
      activity: () => ({ runningTurns: 1, packageOperations: 0, runningTerminals: 0 }),
      shutdown: () => ({ ok: false, error: 'busy' }),
    })
    await controlled.handle({ type: 'host-shutdown', id: 4 })
    expect(sent).toEqual([{ type: 'host-shutdown-result', id: 4, ok: false, error: 'busy' }])
  })
})
