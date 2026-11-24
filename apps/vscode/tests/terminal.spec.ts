/**
 * Terminal output sanitizing: DSH must see the command's own output, never
 * shell-integration control sequences.
 */
import { describe, expect, it, vi } from 'vitest'

// The module imports the VS Code API at load time; the helper under test does not.
vi.mock('vscode', () => ({}))
import { stripControl } from '../src/host/terminal.ts'

describe('stripControl', () => {
  it('removes OSC 633 command markers written by shell integration', () => {
    expect(stripControl('\u001b]633;C\u0007dsh-terminal-smoke')).toBe('dsh-terminal-smoke')
    expect(stripControl('\u001b]633;A\u001b\\out\u001b]633;D;0\u001b\\')).toBe('out')
  })

  it('removes other OSC payloads and carriage returns', () => {
    expect(stripControl('\u001b]0;title\u0007text\r\n')).toBe('text\n')
  })

  it('keeps plain output untouched', () => {
    expect(stripControl('provider-ok\n')).toBe('provider-ok\n')
  })
})
