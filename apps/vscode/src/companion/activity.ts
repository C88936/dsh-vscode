/**
 * Running work the companion reports to the extension's restart check.
 *
 * The extension cannot see a companion's Agents, terminals, or package operations, so the activity query answers from
 * this process instead of letting an idle local view stand in for unknown work.
 * @module @deepseek-ai/dsh-vscode/companion/activity
 */
import { isHostActivityRequest, isHostConfigRequest, isHostShutdownRequest, type HostActivityCounts, type HostModelConfig } from '../shared/host-protocol.ts'
import type { HostConnection, HostSession } from './server.ts'

/** Running work one companion reports. */
export interface HostActivity {
  /** Live Agents running a turn. */
  readonly runningTurns: number
  /** Package-manager operations announced as started and not settled. */
  readonly packageOperations: number
  /** Running DSH terminal commands inside the companion process. */
  readonly runningTerminals: number
}

/** One live Agent as the activity query reads it. */
interface LiveAgent {
  readonly status: string
}

/** One live terminal as the activity query reads it. */
interface LiveTerminal {
  readonly status: { readonly kind: string }
}

/**
 * Collect the running work one application process owns.
 *
 * A service the composition does not mount contributes nothing rather than failing the query: the answer still names
 * every kind of work observable in this process. Running terminals are counted for every live Agent, because a
 * terminal's status does not depend on the Agent's turn state.
 * @param get - service lookup on the live application context.
 * @param packageOperations - ids of manager operations that announced `started` and have not settled.
 * @returns the running counts.
 */
export function hostActivity(get: (name: string) => unknown, packageOperations: ReadonlySet<string>): HostActivity {
  const agents = get('agents') as { list(): readonly LiveAgent[] } | undefined
  const terminals = get('terminals') as { list(agent: LiveAgent): readonly LiveTerminal[] } | undefined
  const live = agents?.list() ?? []
  let runningTerminals = 0
  if (terminals !== undefined) {
    for (const agent of live) {
      runningTerminals += terminals.list(agent).filter(item => item.status.kind === 'running').length
    }
  }
  return {
    runningTurns: live.filter(agent => agent.status === 'running').length,
    packageOperations: packageOperations.size,
    runningTerminals,
  }
}

/** Operations one window may invoke on the shared host over its connection. */
export interface HostControl {
  /**
   * @returns running work the host owns across every window.
   */
  activity(): HostActivityCounts
  /**
   * Answer the deployment model configuration this host booted with.
   * @returns the route, model, and whether a model is configured.
   */
  config?(): HostModelConfig
  /**
   * Accept or refuse a maintenance stop.
   *
   * The host must be able to enter maintenance before it answers, so this may
   * settle asynchronously; it stops after the answer is written.
   * @returns whether the host will stop, and why it refused.
   */
  shutdown?(): MaintenanceAnswer | Promise<MaintenanceAnswer>
}

/** Answer to one maintenance-stop request. */
export interface MaintenanceAnswer {
  /** Whether the host accepted the stop and is shutting down. */
  readonly ok: boolean
  /** Why the stop was refused, when `ok` is false. */
  readonly error?: string
}

/**
 * Answer host-wide control queries one window sends over its connection.
 *
 * The shared host owns every window's work, so both answers are host-wide rather
 * than per connection: a window can ask what is running before a maintenance
 * restart, and only an idle host accepts the stop. Every other frame goes to the
 * connection's transport session unchanged.
 * @param session - the connection's transport session.
 * @param connection - the connection answers are written to.
 * @param control - activity and shutdown implementations owned by the host.
 * @returns a session that answers control frames and delegates the rest.
 */
export function withHostControl(
  session: HostSession,
  connection: HostConnection,
  control: HostControl,
): HostSession {
  return {
    ready: session.ready,
    handle: async (frame: unknown) => {
      if (isHostActivityRequest(frame)) {
        connection.send({
          type: 'host-activity-result',
          id: frame.id,
          activity: control.activity(),
        })
        return
      }
      if (isHostConfigRequest(frame)) {
        connection.send({
          type: 'host-config-result',
          id: frame.id,
          config: control.config?.() ?? { provider: '', model: '', configured: false },
        })
        return
      }
      if (isHostShutdownRequest(frame)) {
        const requested = control.shutdown?.()
        const outcome = requested === undefined
          ? { ok: false, error: 'dsh: this shared host does not support a maintenance stop' }
          : await requested
        connection.send({ type: 'host-shutdown-result', id: frame.id, ...outcome })
        return
      }
      await session.handle(frame)
    },
    dispose: async () => { await session.dispose() },
  }
}
