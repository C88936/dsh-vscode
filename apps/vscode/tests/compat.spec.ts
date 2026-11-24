/**
 * Runtime compatibility: a separately updated DSH installation must match the
 * range the extension declares.
 */
import { describe, expect, it } from 'vitest'
import { runtimeCompatibility } from '../src/host/compat.ts'

const range = '>=0.2.2-alpha.2 <0.3.0'

describe('runtimeCompatibility', () => {
  it('accepts the current prerelease line', () => {
    expect(runtimeCompatibility('0.2.2-alpha.2', range)).toEqual({ ok: true, detail: '0.2.2-alpha.2 satisfies >=0.2.2-alpha.2 <0.3.0' })
    expect(runtimeCompatibility('0.2.9', range).ok).toBe(true)
  })

  it('rejects another minor or major line', () => {
    expect(runtimeCompatibility('0.3.0', range).ok).toBe(false)
    expect(runtimeCompatibility('0.1.9', range).ok).toBe(false)
  })

  it('treats an unknown or malformed version as incompatible', () => {
    expect(runtimeCompatibility(undefined, range)).toEqual({ ok: false, detail: 'runtime version unknown; expected >=0.2.2-alpha.2 <0.3.0' })
    expect(runtimeCompatibility('not-a-version', range).ok).toBe(false)
  })

  it('accepts any runtime when the extension declares no range', () => {
    expect(runtimeCompatibility('9.9.9', undefined)).toEqual({ ok: true, detail: 'no runtime range declared' })
  })
})
