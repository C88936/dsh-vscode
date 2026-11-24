/**
 * Native opening: the carrier hook is the composition signal, and a file
 * address resolves to the absolute path an editor opens.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { nativeOpenTransport, nativeResourceRequest, navigationLine } from '../src/client/native-open.ts'

describe('nativeOpenTransport', () => {
  it('is absent on a page with an in-page document surface', () => {
    expect(nativeOpenTransport({})).toBeUndefined()
    expect(nativeOpenTransport({ __DSH_TRANSPORT__: {} })).toBeUndefined()
  })

  it('reads the resource hook and omits a missing external hook', () => {
    const openResource = vi.fn()
    expect(nativeOpenTransport({ __DSH_TRANSPORT__: { openResource } })).toEqual({ openResource })
  })

  it('reads both hooks when the carrier opens external URLs too', () => {
    const openResource = vi.fn()
    const openExternal = vi.fn()
    expect(nativeOpenTransport({ __DSH_TRANSPORT__: { openResource, openExternal } }))
      .toEqual({ openResource, openExternal })
  })
})

describe('nativeResourceRequest', () => {
  it('keeps only the address for a resource that is not a file', () => {
    expect(nativeResourceRequest({ address: 'dsh-resource://plan/session/s/x' }))
      .toEqual({ address: 'dsh-resource://plan/session/s/x' })
  })

  it('carries an absolute file path unchanged', () => {
    expect(nativeResourceRequest({ address: 'dsh-resource://file/absolute/C:/a/b%20c.txt', line: 4 }))
      .toEqual({ address: 'dsh-resource://file/absolute/C:/a/b%20c.txt', path: 'C:/a/b c.txt', line: 4 })
  })

  it('resolves a session path against that Session workspace root', () => {
    const address = 'dsh-resource://file/session/s-1/docs/a.txt'
    expect(nativeResourceRequest({ address, sessionId: 's-1' as SessionId, cwd: 'C:\\work', line: 2 }))
      .toEqual({ address, path: 'C:\\work\\docs/a.txt', line: 2 })
  })

  it('keeps an unresolved session address to let the host report it', () => {
    const address = 'dsh-resource://file/session/s-1/docs/a.txt'
    expect(nativeResourceRequest({ address, sessionId: 's-1' as SessionId })).toEqual({ address })
    expect(nativeResourceRequest({ address, cwd: '' })).toEqual({ address })
  })
})

describe('navigationLine', () => {
  it('reads a declared 1-based line', () => {
    expect(navigationLine({ line: 12 })).toBe(12)
  })

  it('reports no line for absent or malformed parameters', () => {
    expect(navigationLine(undefined)).toBeUndefined()
    expect(navigationLine(null)).toBeUndefined()
    expect(navigationLine('line')).toBeUndefined()
    expect(navigationLine({})).toBeUndefined()
    expect(navigationLine({ line: '12' })).toBeUndefined()
  })
})
