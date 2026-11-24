/**
 * Editor and terminal requests owned by ready shared-host connections.
 * @module @deepseek-ai/dsh-vscode/companion/window-requests
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostMaintenanceNotice } from '../shared/host-protocol.ts'
import type { HostConnection, HostSession } from './server.ts'

/** Host requests that require a VS Code window. */
export interface WindowRequest {
  readonly type: 'open-file' | 'terminal-run' | 'terminal-cancel'
  readonly id: number
}

/** Response to an editor or terminal request. */
export interface WindowAnswer {
  readonly type: 'open-file-result' | 'terminal-result'
  readonly id: number
  readonly ok: boolean
  readonly output?: string
  readonly exitCode?: number
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly truncated?: boolean
  readonly error?: string
}

/**
 * @param value - frame received from a window.
 * @returns whether it can settle an editor or terminal request.
 */
export function isWindowAnswer(value: unknown): value is WindowAnswer {
  if (value === null || typeof value !== 'object') return false
  const frame = value as Record<string, unknown>
  return (frame.type === 'open-file-result' || frame.type === 'terminal-result')
    && Number.isSafeInteger(frame.id) && typeof frame.ok === 'boolean'
    && (frame.error === undefined || typeof frame.error === 'string')
    && (frame.output === undefined || typeof frame.output === 'string')
    && (frame.exitCode === undefined || Number.isSafeInteger(frame.exitCode))
    && (frame.timedOut === undefined || typeof frame.timedOut === 'boolean')
    && (frame.aborted === undefined || typeof frame.aborted === 'boolean')
    && (frame.truncated === undefined || typeof frame.truncated === 'boolean')
}

/** Dispatches requests to the initiating window when it is still connected. */
export class WindowRequests {
  private readonly windows = new Set<HostConnection>()
  private readonly initiator = new AsyncLocalStorage<HostConnection>()
  private readonly terminals = new Map<number, HostConnection>()
  private readonly editors = new Map<number, HostConnection>()
  private maintenance: HostMaintenanceNotice | undefined

  /** @param settle - completes a request in the companion. */
  constructor(private readonly settle: (answer: WindowAnswer) => void) {}

  /**
   * @param connection - window owning the transport.
   * @param session - its per-window transport session.
   * @returns a transport that registers after readiness and cleans up on disconnect.
   */
  bind(connection: HostConnection, session: HostSession): HostSession {
    return {
      ...session,
      onReady: () => {
        session.onReady?.()
        this.windows.add(connection)
        if (this.maintenance !== undefined) connection.send(this.maintenance)
      },
      handle: async frame => {
        if (!isWindowAnswer(frame)) {
          await this.initiator.run(connection, () => session.handle(frame))
          return
        }
        const owners = frame.type === 'open-file-result' ? this.editors : this.terminals
        if (owners.get(frame.id) !== connection) return
        owners.delete(frame.id)
        this.settle(frame)
      },
      dispose: async () => {
        this.windows.delete(connection)
        this.failOwned(this.editors, connection, 'open-file-result')
        this.failOwned(this.terminals, connection, 'terminal-result')
        await session.dispose()
      },
    }
  }

  /**
   * @param frame - request with the original opaque payload.
   * @returns whether it was delivered. Terminal cancellation stays with its owner.
   */
  send<R extends WindowRequest>(frame: R): boolean {
    if (frame.type === 'terminal-cancel') {
      const owner = this.terminals.get(frame.id)
      owner?.send(frame)
      return owner !== undefined
    }
    const initiator = this.initiator.getStore()
    const target = initiator !== undefined && this.windows.has(initiator)
      ? initiator
      : [...this.windows].at(-1)
    if (target === undefined) return false
    const owners = frame.type === 'open-file' ? this.editors : this.terminals
    owners.set(frame.id, target)
    target.send(frame)
    return true
  }

  /** @param frame - restart maintenance state for current and newly ready windows. */
  broadcastMaintenance(frame: HostMaintenanceNotice): void {
    this.maintenance = frame.active ? frame : undefined
    for (const connection of this.windows) connection.send(frame)
  }

  private failOwned(owners: Map<number, HostConnection>, connection: HostConnection, type: WindowAnswer['type']): void {
    for (const [id, owner] of owners) {
      if (owner !== connection) continue
      owners.delete(id)
      this.settle({ type, id, ok: false, error: 'the VS Code window handling this request disconnected' })
    }
  }
}
