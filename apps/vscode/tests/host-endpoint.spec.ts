/**
 * Shared-host endpoint naming and token publication: one storage maps to one
 * endpoint, the token is stable across racing windows, and a malformed token
 * file is not accepted.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostToken, readHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @returns a fresh temporary storage directory.
 */
function storage(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-endpoint-'))
  roots.push(root)
  return root
}

describe('resolveHostEndpoint', () => {
  it('derives the same endpoint for the same storage', () => {
    const dir = storage()
    const first = resolveHostEndpoint(dir)
    const second = resolveHostEndpoint(dir)
    expect(second.endpoint).toBe(first.endpoint)
    expect(second.tokenPath).toBe(first.tokenPath)
    expect(second.runtimeDir).toBe(join(dir, 'runtime'))
    expect(second.lockPath).toBe(join(dir, 'runtime', 'host.lock'))
  })

  it('separates storage directories that are not the same', () => {
    const first = resolveHostEndpoint(storage())
    const second = resolveHostEndpoint(storage())
    expect(first.endpoint).not.toBe(second.endpoint)
  })

  it('names a pipe on Windows and a socket file elsewhere', () => {
    const endpoint = resolveHostEndpoint(storage())
    if (process.platform === 'win32') {
      expect(endpoint.transport).toBe('pipe')
      expect(endpoint.endpoint.startsWith('\\\\.\\pipe\\dsh-vscode-v1-')).toBe(true)
      expect(endpoint.socketPath).toBeUndefined()
      return
    }
    expect(endpoint.transport).toBe('unix')
    expect(endpoint.endpoint).toBe(endpoint.socketPath)
    expect(endpoint.endpoint.endsWith('.sock')).toBe(true)
    expect(endpoint.endpoint.startsWith(tmpdir())).toBe(true)
  })
})

describe('host token', () => {
  it('publishes one token and keeps it for later windows', () => {
    const { tokenPath } = resolveHostEndpoint(storage())
    const token = createHostToken(tokenPath)
    expect(token).toMatch(/^[0-9a-f]{64}$/u)
    expect(readHostToken(tokenPath)).toBe(token)
    expect(createHostToken(tokenPath)).toBe(token)
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token)
  })

  it('reports no token before one is published or when the file is malformed', () => {
    const { tokenPath } = resolveHostEndpoint(storage())
    expect(readHostToken(tokenPath)).toBeUndefined()
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, 'not-a-token\n')
    expect(readHostToken(tokenPath)).toBeUndefined()
    // A malformed file does not become the credential; the next start replaces it.
    expect(createHostToken(tokenPath)).toMatch(/^[0-9a-f]{64}$/u)
  })
})
