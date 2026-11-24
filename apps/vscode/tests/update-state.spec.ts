/**
 * Update state machine: one explicit path from checking to installing, with the version and the failure reason carried
 * by the state, and an event that does not apply to the current state refused instead of applied.
 */
import { describe, expect, it } from 'vitest'
import { parseUpdateManifest, type UpdateManifest } from '../src/host/update/manifest.ts'
import {
  describeUpdateState,
  nextUpdateState,
  UpdateStateMachine,
  type UpdateState,
} from '../src/host/update/state.ts'

/** @returns one validated feed for a transition. */
function manifest(): UpdateManifest {
  const result = parseUpdateManifest(JSON.stringify({
    schemaVersion: 'dsh-vscode-update/v1',
    extensionId: 'deepseek-ai.dsh-vscode',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
    targetPlatform: 'universal',
    url: 'https://updates.lan/dsh/dsh-vscode-0.2.0.vsix',
    sha256: 'a'.repeat(64),
    size: 1024,
    publishedAt: '2026-11-19T12:00:00.000Z',
  }))
  if (!result.ok) throw new Error(result.problem.detail)
  return result.manifest
}

/**
 * @param state - starting state. @param events - events to apply in order.
 * @returns the state after the last applied event, or the first refusal.
 */
function run(state: UpdateState, events: Parameters<typeof nextUpdateState>[1][]) {
  let current = state
  for (const event of events) {
    const transition = nextUpdateState(current, event)
    if (!transition.ok) return transition
    current = transition.state
  }
  return { ok: true as const, state: current }
}

describe('update state machine', () => {
  it('walks check, download, verify, and install in order', () => {
    const result = run({ name: 'idle' }, [
      { type: 'check-started' },
      { type: 'update-available', manifest: manifest() },
      { type: 'download-started' },
      { type: 'download-staged', path: 'C:/storage/updates/dsh-vscode-0.2.0.vsix', sha256: 'b'.repeat(64) },
      { type: 'install-started' },
      { type: 'install-finished' },
    ])
    expect(result.ok).toBe(true)
    expect(result.ok && result.state).toEqual({ name: 'idle' })
  })

  it('carries the version through every step that has a file', () => {
    const available = nextUpdateState({ name: 'checking' }, { type: 'update-available', manifest: manifest() })
    expect(available.ok && available.state).toMatchObject({ name: 'available', version: '0.2.0' })
    if (!available.ok) return
    const downloading = nextUpdateState(available.state, { type: 'download-started' })
    expect(downloading.ok && downloading.state).toMatchObject({ name: 'downloading', version: '0.2.0' })
    if (!downloading.ok) return
    const staged = nextUpdateState(downloading.state, {
      type: 'download-staged',
      path: 'C:/updates/dsh-vscode-0.2.0.vsix',
      sha256: 'b'.repeat(64),
    })
    expect(staged.ok && staged.state).toMatchObject({
      name: 'staged',
      version: '0.2.0',
      path: 'C:/updates/dsh-vscode-0.2.0.vsix',
      sha256: 'b'.repeat(64),
    })
  })

  it('refuses a download or install before the earlier step produced its result', () => {
    const earlyDownload = nextUpdateState({ name: 'idle' }, { type: 'download-started' })
    expect(earlyDownload).toMatchObject({ ok: false, from: 'idle', event: 'download-started' })
    const earlyInstall = nextUpdateState(
      { name: 'available', manifest: manifest(), version: '0.2.0' },
      { type: 'install-started' },
    )
    expect(earlyInstall).toMatchObject({ ok: false, from: 'available', event: 'install-started' })
  })

  it('returns to idle when a check finds nothing', () => {
    expect(run({ name: 'idle' }, [{ type: 'check-started' }, { type: 'no-update' }])).toMatchObject({
      ok: true,
      state: { name: 'idle' },
    })
  })

  it('records the failure with the version it was working on', () => {
    const available: UpdateState = { name: 'available', manifest: manifest(), version: '0.2.0' }
    const failed = nextUpdateState(available, { type: 'failed', reason: 'the digest does not match' })
    expect(failed.ok && failed.state).toEqual({
      name: 'failed',
      version: '0.2.0',
      reason: 'the digest does not match',
    })
  })

  it('records a failure with no version when the check failed first', () => {
    const failed = nextUpdateState({ name: 'checking' }, { type: 'failed', reason: 'the feed answered HTTP 500' })
    expect(failed.ok && failed.state).toEqual({
      name: 'failed',
      version: undefined,
      reason: 'the feed answered HTTP 500',
    })
  })

  it('accepts a failure from every state, so no attempt is left looking successful', () => {
    const states: UpdateState[] = [
      { name: 'idle' },
      { name: 'checking' },
      { name: 'available', manifest: manifest(), version: '0.2.0' },
      { name: 'downloading', manifest: manifest(), version: '0.2.0' },
      {
        name: 'staged',
        manifest: manifest(),
        version: '0.2.0',
        path: 'C:/updates/dsh-vscode-0.2.0.vsix',
        sha256: 'b'.repeat(64),
      },
      {
        name: 'installing',
        manifest: manifest(),
        version: '0.2.0',
        path: 'C:/updates/dsh-vscode-0.2.0.vsix',
        sha256: 'b'.repeat(64),
      },
      { name: 'failed', version: undefined, reason: 'earlier failure' },
    ]
    for (const state of states) {
      expect(nextUpdateState(state, { type: 'failed', reason: 'stopped' })).toMatchObject({ ok: true })
    }
  })

  it('resets to idle from any state', () => {
    expect(nextUpdateState({ name: 'failed', version: '0.2.0', reason: 'x' }, { type: 'reset' })).toMatchObject({
      ok: true,
      state: { name: 'idle' },
    })
    expect(nextUpdateState({ name: 'installing', manifest: manifest(), version: '0.2.0', path: 'p', sha256: 's' }, {
      type: 'reset',
    })).toMatchObject({ ok: true, state: { name: 'idle' } })
  })

  it('describes a state with the version and the failure reason', () => {
    expect(describeUpdateState({ name: 'idle' })).toBe('idle')
    expect(describeUpdateState({ name: 'available', manifest: manifest(), version: '0.2.0' })).toBe('available 0.2.0')
    expect(describeUpdateState({ name: 'failed', version: '0.2.0', reason: 'digest mismatch' }))
      .toBe('failed (0.2.0): digest mismatch')
    expect(describeUpdateState({ name: 'failed', version: undefined, reason: 'offline' })).toBe('failed: offline')
  })

  it('keeps the state unchanged when the owner refuses an event', () => {
    const machine = new UpdateStateMachine()
    const refused = machine.apply({ type: 'install-started' })
    expect(refused.ok).toBe(false)
    expect(machine.state).toEqual({ name: 'idle' })
    machine.apply({ type: 'check-started' })
    expect(machine.state).toEqual({ name: 'checking' })
  })
})
