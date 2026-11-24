/**
 * Host-wide maintenance gate for module-replacing plugin operations.
 *
 * A plugin install, update, removal, repair, or bundle/row selection change can
 * replace code other sessions are using. The shared host serializes those
 * operations, refuses them while any window's work is running, and while one is
 * in flight refuses new turns, so a turn cannot start between the check and the
 * replacement. The plugin manager's own profile lock still serializes the
 * operations themselves; this gate only adds the host-wide admission rule.
 *
 * @module @deepseek-ai/dsh-vscode/companion/maintenance
 */
import type { HostConnection, HostSession } from './server.ts'

/** Remote methods that can replace or remove loaded module code. */
const MODULE_OPERATIONS: ReadonlySet<string> = new Set([
  'pluginManager/installBundle',
  'pluginManager/updateBundle',
  'pluginManager/removeBundle',
  'pluginManager/repairBundle',
  'pluginManager/setBundleEnabled',
  'pluginManager/setPluginEnabled',
  'pluginManager/setVersionExemption',
])

/** Remote methods that start a turn. */
const TURN_OPERATIONS: ReadonlySet<string> = new Set(['session/prompt'])

/** Activity counts one gate check reads. */
export interface MaintenanceActivity {
  readonly runningTurns: number
  readonly packageOperations: number
  readonly runningTerminals: number
}

/** Inputs for one host-wide gate. */
export interface MaintenanceGateOptions {
  /** Read the host's current work. */
  readonly activity: () => MaintenanceActivity
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** Name the sessions running a turn, for the refusal report. */
  readonly runningSessions?: () => readonly string[]
}

/** Serializes module operations and closes turn admission while one runs. */
export class MaintenanceGate {
  private tail: Promise<void> = Promise.resolve()
  private active = false

  /** @param options - activity reader and diagnostic sink. */
  constructor(private readonly options: MaintenanceGateOptions) {}

  /** Whether a module operation or restart currently holds the gate. */
  get inMaintenance(): boolean {
    return this.active
  }

  /**
   * @returns the host's current work, as configured.
   */
  currentActivity(): MaintenanceActivity {
    return this.options.activity()
  }

  /**
   * @param line - diagnostic text.
   */
  log(line: string): void {
    this.options.log(line)
  }

  /**
   * @returns the sessions running a turn, as configured.
   */
  sessions(): readonly string[] {
    return this.options.runningSessions?.() ?? []
  }

  /**
   * Wait for exclusive maintenance and mark it active.
   * @returns a function that releases the gate.
   */
  async acquire(): Promise<() => void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    this.active = true
    return () => {
      this.active = false
      release()
    }
  }
}

/**
 * @param frame - decoded Webview frame.
 * @returns the Remote method name, when the frame is one fetch call.
 */
function methodOf(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const value = frame as { type?: unknown; body?: unknown }
  if (value.type !== 'fetch' || typeof value.body !== 'string') return undefined
  try {
    const body: unknown = JSON.parse(value.body)
    if (typeof body !== 'object' || body === null) return undefined
    const method = (body as { method?: unknown }).method
    return typeof method === 'string' ? method : undefined
  } catch (_error) {
    // The fetch handler reports malformed JSON.
    return undefined
  }
}

/**
 * Answer one refused frame with the error shape the Webview transport reads.
 * @param connection - connection to answer.
 * @param id - fetch request id.
 * @param code - stable failure code.
 * @param message - user-facing explanation.
 */
function refuse(connection: HostConnection, id: number, code: string, message: string): void {
  connection.send({
    type: 'fetch-result',
    id,
    status: 409,
    body: JSON.stringify({ result: { ok: false, error: { code, message } } }),
  })
}

/**
 * @param activity - current host work.
 * @returns a phrase naming the running counts, or undefined when idle.
 */
function busyReason(activity: MaintenanceActivity): string | undefined {
  const parts: string[] = []
  if (activity.runningTurns > 0) parts.push(`${String(activity.runningTurns)} running ${activity.runningTurns === 1 ? 'turn' : 'turns'}`)
  if (activity.packageOperations > 0) {
    parts.push(`${String(activity.packageOperations)} running package ${activity.packageOperations === 1 ? 'operation' : 'operations'}`)
  }
  if (activity.runningTerminals > 0) {
    parts.push(`${String(activity.runningTerminals)} running terminal ${activity.runningTerminals === 1 ? 'command' : 'commands'}`)
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}

/**
 * Wrap one connection's session with the host-wide maintenance rules.
 *
 * Control frames (`host-activity`, `host-shutdown`) pass through untouched; the
 * caller wraps them separately.
 * @param session - the connection's transport session.
 * @param connection - the connection the session writes to.
 * @param gate - the host-wide gate.
 * @returns the gated session.
 */
export function withMaintenanceGate(
  session: HostSession,
  connection: HostConnection,
  gate: MaintenanceGate,
): HostSession {
  let disconnected = false
  return {
    ...session,
    handle: async (frame: unknown) => {
      if (disconnected) return
      const method = methodOf(frame)
      if (method !== undefined && MODULE_OPERATIONS.has(method)) {
        const release = await gate.acquire()
        try {
          if (disconnected) return
          const busy = busyReason(gate.currentActivity())
          const id = fetchId(frame)
          if (busy !== undefined && id !== undefined) {
            const sessions = gate.sessions()
            const named = sessions.length === 0
              ? ''
              : ` Running sessions: ${sessions.slice(0, 5).join(', ')}${sessions.length > 5 ? '…' : ''}.`
            gate.log(`dsh host: refused ${method}: ${busy}${named}`)
            refuse(connection, id, 'plugin-manager/maintenance-busy', `DSH is still running ${busy}; the plugin change was not started.${named}`)
            return
          }
          // Unary fetch awaits the Host method, even when peer disposal aborts
          // the request and the window no longer receives a reply.
          await session.handle(frame)
        } finally {
          release()
        }
        return
      }
      if (method !== undefined && TURN_OPERATIONS.has(method) && gate.inMaintenance) {
        const id = fetchId(frame)
        if (id !== undefined) {
          refuse(connection, id, 'session/maintenance', 'DSH is applying a plugin change; wait for it to finish before starting another turn.')
          return
        }
      }
      await session.handle(frame)
    },
    dispose: async () => {
      disconnected = true
      await session.dispose()
    },
  }
}

/**
 * @param frame - decoded fetch frame.
 * @returns its numeric request id.
 */
function fetchId(frame: unknown): number | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const id = (frame as { id?: unknown }).id
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined
}
