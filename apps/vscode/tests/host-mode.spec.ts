/**
 * The production host stays on the managed companion path independent of the
 * extension host's Electron release. In-process boot requires the explicit
 * internal experiment flag.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined }),
  },
}))

import { resolveHostMode } from '../src/host/host.ts'

describe('resolveHostMode', () => {
  it('uses the managed companion by default', () => {
    expect(resolveHostMode({})).toBe('companion')
  })

  it('selects in-process only through the explicit experiment flag', () => {
    expect(resolveHostMode({ DSH_VSCODE_EXPERIMENTAL_IN_PROCESS: '1' })).toBe('in-process')
  })

  it('keeps managed mode when the experiment value is not exactly enabled', () => {
    expect(resolveHostMode({ DSH_VSCODE_EXPERIMENTAL_IN_PROCESS: 'true' })).toBe('companion')
    expect(resolveHostMode({ DSH_VSCODE_EXPERIMENTAL_IN_PROCESS: '0' })).toBe('companion')
  })
})
