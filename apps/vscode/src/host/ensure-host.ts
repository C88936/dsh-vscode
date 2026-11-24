/**
 * Connect one VS Code window to the shared DSH host, starting it only when no
 * window is serving the storage.
 *
 * The window that wins the spawn lock creates the host; a window that loses the
 * lock waits for the winner's endpoint instead of starting a second host. A
 * window that already found a live host connects without taking the lock. The
 * interface is generic over the connection so tests can drive the orchestration
 * without a DSH boot.
 *
 * @module @deepseek-ai/dsh-vscode/host/ensure-host
 */
import { acquireSpawnLock, type SpawnLockOptions } from '../shared/host-lock.ts'
import { HostRefusedError } from './host-client.ts'

/** Inputs for one connect-or-start attempt. */
export interface EnsureSharedHostOptions<T> {
  /** Spawn lock path below the storage runtime directory. */
  readonly lockPath: string
  /** Connects to a running host; rejects when none is reachable. */
  readonly connect: () => Promise<T>
  /** Starts one host and resolves when it can accept a connection. */
  readonly start: () => Promise<void>
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** How long to wait for another window's start, or for a just-started host. */
  readonly waitMs?: number
  /** Delay between connection attempts while waiting. */
  readonly retryMs?: number
  /** Storage recorded in the lock, for diagnostics. */
  readonly storageDir?: string
  /** Lock clock, liveness probe, and age limit; tests inject them. */
  readonly lock?: SpawnLockOptions
}

/** One connection plus whether this call started the host. */
export interface EnsuredSharedHost<T> {
  readonly connection: T
  readonly started: boolean
}

/** Default wait for a started or concurrently starting host, in milliseconds. */
const DEFAULT_WAIT_MS = 20_000

/** Default retry interval while waiting, in milliseconds. */
const DEFAULT_RETRY_MS = 100

/**
 * Connect to the shared host, starting one only when no window owns it.
 *
 * A window that finds an unreachable endpoint takes the spawn lock and checks
 * again before spawning, so two windows that raced past their first connection
 * attempt still create at most one host. The lock is released on every exit
 * path, including a failed start.
 * @param options - connection, start, lock, and wait inputs.
 * @returns the connection and whether this call started the host.
 * @throws when the host cannot be reached or started within the wait budget.
 */
export async function ensureSharedHost<T>(options: EnsureSharedHostOptions<T>): Promise<EnsuredSharedHost<T>> {
  const existing = await tryConnect(options.connect)
  if (existing !== undefined) return { connection: existing, started: false }

  const lock = acquireSpawnLock(options.lockPath, {
    ...options.lock ?? {},
    ...options.storageDir === undefined ? {} : { storageDir: options.storageDir },
  })
  if (lock === undefined) {
    options.log('dsh: another window is starting the shared DSH host; waiting for it')
    const connection = await waitForConnection(options)
    return { connection, started: false }
  }
  try {
    // The other window may have released the lock after starting; connecting
    // again here avoids a second host for a race that already resolved.
    const current = await tryConnect(options.connect)
    if (current !== undefined) return { connection: current, started: false }
    options.log('dsh: starting the shared DSH host for this storage')
    await options.start()
    const connection = await waitForConnection(options)
    return { connection, started: true }
  } finally {
    lock.release()
  }
}

/**
 * @param connect - connection attempt.
 * @returns the connection, or undefined when no host answered.
 * @throws when a host answered and refused this window.
 */
async function tryConnect<T>(connect: () => Promise<T>): Promise<T | undefined> {
  try {
    return await connect()
  } catch (error) {
    // A refusal means a host exists and decided this window may not use it;
    // starting another host cannot fix that and would split the shared state.
    if (error instanceof HostRefusedError) throw error
    return undefined
  }
}

/**
 * Retry the connection until a host answers or the wait budget ends.
 *
 * A refusal is retried like an unreachable endpoint: the token file can be
 * replaced by the starting window, and a stale refusal from a host that is
 * shutting down is not a final answer.
 * @param options - connection and wait inputs.
 * @returns the admitted connection.
 * @throws when no connection succeeds within the budget.
 */
async function waitForConnection<T>(options: EnsureSharedHostOptions<T>): Promise<T> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const deadline = Date.now() + waitMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      return await options.connect()
    } catch (error) {
      if (error instanceof HostRefusedError) throw error
      lastError = error
      await new Promise<void>((resolve) => { setTimeout(resolve, retryMs) })
    }
  }
  throw new Error(
    `dsh: the shared DSH host did not become reachable within ${String(waitMs)} ms: ${describe(lastError)}`,
  )
}

/**
 * @param error - thrown value.
 * @returns its message or string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
