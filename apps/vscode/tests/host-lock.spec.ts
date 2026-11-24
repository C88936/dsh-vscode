/**
 * Spawn-lock behavior: exactly one window starts the shared host, a dead or
 * over-age owner is replaced, and releasing never deletes another owner's lock.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSpawnLock, isProcessAlive } from '../src/shared/host-lock.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a lock path inside a fresh temporary directory.
 */
function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-lock-'))
  roots.push(root)
  return join(root, 'runtime', 'host.lock')
}

/**
 * Write one lock record directly, as another starter would have.
 * @param path - lock file path.
 * @param record - record fields.
 */
function writeLock(path: string, record: { pid: number; startedAt: number }): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...record, storageDir: 'C:\\storage' })}\n`)
}

describe('acquireSpawnLock', () => {
  it('creates the lock, records this process, and removes it on release', () => {
    const path = lockPath()
    const lock = acquireSpawnLock(path)
    expect(lock).toBeDefined()
    expect(existsSync(path)).toBe(true)
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    expect(record).toMatchObject({ pid: process.pid })
    lock?.release()
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a lock whose owner is still alive', () => {
    const path = lockPath()
    const first = acquireSpawnLock(path)
    expect(first).toBeDefined()
    expect(acquireSpawnLock(path)).toBeUndefined()
    first?.release()
  })

  it('replaces a lock whose owner process is gone', () => {
    const path = lockPath()
    writeLock(path, { pid: 999_999, startedAt: Date.now() })
    const lock = acquireSpawnLock(path, { alive: () => false })
    expect(lock).toBeDefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock?.release()
  })

  it('replaces a lock older than the age limit even when its pid exists', () => {
    const path = lockPath()
    writeLock(path, { pid: 42, startedAt: 1_000 })
    const lock = acquireSpawnLock(path, { alive: () => true, now: () => 1_000 + 60_001, maxAgeMs: 60_000 })
    expect(lock).toBeDefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock?.release()
  })

  it('treats an unreadable lock file as stale', () => {
    const path = lockPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not a lock record\n')
    const lock = acquireSpawnLock(path)
    expect(lock).toBeDefined()
    lock?.release()
  })

  it('does not remove a lock file that another process now owns', () => {
    const path = lockPath()
    const lock = acquireSpawnLock(path)
    expect(lock).toBeDefined()
    writeLock(path, { pid: process.pid + 1, startedAt: Date.now() })
    lock?.release()
    expect(existsSync(path)).toBe(true)
  })
})

describe('isProcessAlive', () => {
  it('reports this process and rejects impossible ids', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
