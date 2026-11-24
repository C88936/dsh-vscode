/**
 * Spawn lock for the shared DSH host.
 *
 * Several VS Code windows can activate at the same moment. The lock lets
 * exactly one of them start a host while the others wait for its endpoint; it
 * must be taken before any shared state (the token, the host process) is
 * created. A lock whose owner died, or whose age passed the limit while its pid
 * still exists, is broken so a crash cannot block every later window.
 *
 * @module @deepseek-ai/dsh-vscode/shared/host-lock
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default age after which a lock with a live pid is treated as abandoned. */
const DEFAULT_MAX_AGE_MS = 5 * 60_000

/** Record one lock file carries. */
interface LockRecord {
  /** Process that took the lock. */
  readonly pid: number
  /** Wall-clock time the lock was taken, in milliseconds. */
  readonly startedAt: number
  /** Extension storage the lock belongs to, for diagnostics. */
  readonly storageDir: string
}

/** One acquired spawn lock. */
export interface SpawnLock {
  /** Absolute path of the lock file this handle owns. */
  readonly path: string
  /** Remove the file when this process still owns it. */
  release(): void
}

/** Inputs for one lock attempt. */
export interface SpawnLockOptions {
  /** Clock, in milliseconds; tests inject one. */
  readonly now?: () => number
  /** Liveness probe for a recorded pid; tests inject one. */
  readonly alive?: (pid: number) => boolean
  /** Age that lets a new starter break a lock whose owner is still alive. */
  readonly maxAgeMs?: number
  /** Storage directory recorded in the lock, for diagnostics. */
  readonly storageDir?: string
}

/**
 * Take the spawn lock, breaking one left by a dead or over-age owner.
 * @param lockPath - lock file path below the storage runtime directory.
 * @param options - clock, liveness probe, age limit, and recorded storage.
 * @returns the lock, or undefined when another live window owns it.
 */
export function acquireSpawnLock(lockPath: string, options: SpawnLockOptions = {}): SpawnLock | undefined {
  const now = options.now ?? Date.now
  const alive = options.alive ?? isProcessAlive
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  mkdirSync(dirname(lockPath), { recursive: true })
  const record: LockRecord = {
    pid: process.pid,
    startedAt: now(),
    storageDir: options.storageDir ?? '',
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeLock(lockPath, record)) return lockHandle(lockPath)
    const owner = readLock(lockPath)
    if (owner !== undefined && isLive(owner, alive, maxAgeMs, now())) return undefined
    // The owner is gone or the record is unreadable. Removing the file can race
    // another starter that just replaced it; the second write attempt then
    // fails and reports the lock as taken.
    try {
      unlinkSync(lockPath)
    } catch {
      // Already removed by the owner or another starter.
    }
  }
  return undefined
}

/**
 * @param lockPath - lock file path.
 * @param record - record to write.
 * @returns whether the file was created exclusively.
 */
function writeLock(lockPath: string, record: LockRecord): boolean {
  try {
    writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * @param lockPath - lock file path.
 * @returns its parsed record, or undefined when missing or malformed.
 */
function readLock(lockPath: string): LockRecord | undefined {
  let text: string
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch {
    // No lock file means the owner released it between the write attempt and
    // this read; the next write attempt can take it.
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { pid?: unknown; startedAt?: unknown; storageDir?: unknown }
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return undefined
    if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) return undefined
    return { pid: record.pid, startedAt: record.startedAt, storageDir: typeof record.storageDir === 'string' ? record.storageDir : '' }
  } catch {
    return undefined
  }
}

/**
 * @param record - recorded owner.
 * @param alive - liveness probe.
 * @param maxAgeMs - age limit for a live owner.
 * @param now - current time in milliseconds.
 * @returns whether the recorded owner still blocks a new starter.
 */
function isLive(record: LockRecord, alive: (pid: number) => boolean, maxAgeMs: number, now: number): boolean {
  if (now - record.startedAt > maxAgeMs) return false
  return alive(record.pid)
}

/**
 * @param lockPath - lock file this handle owns.
 * @returns a handle that removes the file only while this process owns it.
 */
function lockHandle(lockPath: string): SpawnLock {
  return {
    path: lockPath,
    release(): void {
      const owner = readLock(lockPath)
      if (owner !== undefined && owner.pid !== process.pid) return
      try {
        unlinkSync(lockPath)
      } catch {
        // Another starter already broke the lock; nothing to release.
      }
    },
  }
}

/**
 * @param pid - process id from a lock record.
 * @returns whether a process with that id exists for this user.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user; it is alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
