/**
 * Connect-or-start orchestration: one window connects without taking the lock,
 * one starter wins the lock, another starter waits for its endpoint, refusals
 * propagate instead of spawning a second host, and the lock is released on
 * every exit path.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSharedHost } from '../src/host/ensure-host.ts'
import { HostRefusedError } from '../src/host/host-client.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a lock path inside a fresh temporary directory.
 */
function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-host-'))
  roots.push(root)
  return join(root, 'runtime', 'host.lock')
}

/**
 * Write one live lock held by this test process.
 * @param path - lock file path.
 */
function holdLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), storageDir: 'C:\\storage' })}\n`)
}

const LOG = (): void => {}

describe('ensureSharedHost', () => {
  it('connects to a running host without taking the lock or starting one', async () => {
    const path = lockPath()
    const connection = { id: 'existing' }
    let started = false
    const result = await ensureSharedHost({
      lockPath: path,
      connect: async () => connection,
      start: async () => { started = true },
      log: LOG,
    })
    expect(result.connection).toBe(connection)
    expect(result.started).toBe(false)
    expect(started).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('starts a host when none answers and releases the lock afterwards', async () => {
    const path = lockPath()
    const connection = { id: 'started' }
    let attempts = 0
    let started = false
    const result = await ensureSharedHost({
      lockPath: path,
      connect: async () => {
        attempts++
        if (!started) throw new Error('connect ECONNREFUSED')
        return connection
      },
      start: async () => { started = true },
      log: LOG,
    })
    expect(result).toMatchObject({ connection, started: true })
    // One failed attempt before the lock, one re-check under it, and one after
    // the start; the host is never started twice.
    expect(attempts).toBe(3)
    expect(existsSync(path)).toBe(false)
  })

  it('does not start a second host when another starter won the race', async () => {
    const path = lockPath()
    const connection = { id: 'raced' }
    let calls = 0
    let started = false
    const result = await ensureSharedHost({
      lockPath: path,
      connect: async () => {
        calls++
        // The first attempt fails; by the time this window re-checks under its
        // lock, the other window has already started the host.
        if (calls === 1) throw new Error('connect ECONNREFUSED')
        return connection
      },
      start: async () => { started = true },
      log: LOG,
    })
    expect(result.started).toBe(false)
    expect(started).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('propagates a host refusal instead of starting another host', async () => {
    const path = lockPath()
    let started = false
    const refusal = new HostRefusedError('token', 'the access token is stale')
    await expect(ensureSharedHost({
      lockPath: path,
      connect: async () => { throw refusal },
      start: async () => { started = true },
      log: LOG,
    })).rejects.toBe(refusal)
    expect(started).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('releases the lock when starting fails', async () => {
    const path = lockPath()
    const failure = new Error('the host did not boot')
    await expect(ensureSharedHost({
      lockPath: path,
      connect: async () => { throw new Error('connect ECONNREFUSED') },
      start: async () => { throw failure },
      log: LOG,
    })).rejects.toBe(failure)
    expect(existsSync(path)).toBe(false)
  })

  it('waits for another window instead of starting when its lock is live', async () => {
    const path = lockPath()
    holdLock(path)
    let started = false
    await expect(ensureSharedHost({
      lockPath: path,
      connect: async () => { throw new Error('connect ECONNREFUSED') },
      start: async () => { started = true },
      log: LOG,
      waitMs: 50,
      retryMs: 10,
    })).rejects.toThrow(/did not become reachable/u)
    expect(started).toBe(false)
    expect(existsSync(path)).toBe(true)
  })
})
