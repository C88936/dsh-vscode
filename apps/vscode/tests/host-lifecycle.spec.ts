/**
 * Managed-host lifecycle: one live companion per generation, restart replaces
 * it exactly once, and stop reaches the observable stopped state.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({
  starts: 0,
  disposals: 0,
  /** Work the mocked companion reports for the activity query. */
  activity: { runningTurns: 0, packageOperations: 0, runningTerminals: 0 },
  onExit: undefined as ((exit: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined,
}))

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: 'E:/LLM_project/dsh-vscode' } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
}))

vi.mock('../src/host/companion-bridge.ts', () => ({
  resolveNodeExecutable: () => process.execPath,
  CompanionBridge: {
    start: async (options: { onExit?: typeof observed.onExit }) => {
      observed.starts++
      observed.onExit = options.onExit
      let disposed = false
      return {
        prepare: async () => ({ injections: [], assets: {}, shell: 'shell', styles: [] }),
        handle: async () => {},
        activity: async () => observed.activity,
        dispose: async () => {
          if (disposed) return
          disposed = true
          observed.disposals++
        },
      }
    },
  },
}))

import { DshHost, restartRefusal } from '../src/host/host.ts'

/** Isolated global storage: launch files are written below it on each start. */
const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-vscode-host-lifecycle-'))

afterAll(() => {
  delete process.env.DSH_VSCODE_SHARED_HOST
  rmSync(storageRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // The per-window companion is the fallback; this suite pins it explicitly.
  process.env.DSH_VSCODE_SHARED_HOST = '0'
})

const extension = {
  extensionUri: { fsPath: 'E:/LLM_project/dsh-vscode/apps/vscode' },
  globalStorageUri: { fsPath: storageRoot },
  extension: { packageJSON: { version: 'test' } },
}

const webview = {
  asUri: (path: string) => path,
  postMessage: async () => true,
}

describe('restartRefusal', () => {
  it('allows a restart when nothing is observable or no companion can report', () => {
    expect(restartRefusal(undefined)).toBeUndefined()
    expect(restartRefusal({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 })).toBeUndefined()
  })

  it('names every kind of running work in the refusal', () => {
    const refusal = restartRefusal({ runningTurns: 1, packageOperations: 2, runningTerminals: 3 })
    expect(refusal).toContain('1 running turn')
    expect(refusal).toContain('2 running package operations')
    expect(refusal).toContain('3 running terminal commands')
    expect(refusal).toContain('the restart was not started')
  })
})

describe('DshHost managed lifecycle', () => {
  it('starts once per view, restarts once, and stops cleanly', async () => {
    const host = new DshHost(extension as never, () => {})

    expect(host.snapshot().state).toBe('stopped')

    await host.start()
    expect(host.snapshot().state).toBe('starting')

    const first = await host.createBridge(webview)
    expect(host.snapshot().state).toBe('ready')
    expect(observed.starts).toBe(1)
    observed.onExit?.({ code: 1, signal: null })
    expect(host.snapshot().state).toBe('failed')

    await host.restart()
    expect(host.snapshot().state).toBe('starting')

    const second = await host.createBridge(webview)
    expect(host.snapshot().state).toBe('ready')
    expect(observed.starts).toBe(2)
    expect(observed.disposals).toBe(1)

    await first.dispose()
    await second.dispose()
    await host.stop()

    expect(host.snapshot().state).toBe('stopped')
    expect(observed.disposals).toBe(2)
  })

  it('refuses a restart when the companion still reports running work, and keeps the running host', async () => {
    observed.activity = { runningTurns: 2, packageOperations: 1, runningTerminals: 0 }
    const host = new DshHost(extension as never, () => {})
    try {
      await host.start()
      await host.createBridge(webview)
      const starts = observed.starts
      const disposals = observed.disposals

      // The caller's earlier check and this stop are separated by asynchronous work, so the host asks again.
      await expect(host.restart()).rejects.toThrow(/still reports 2 running turns, 1 running package operation/u)
      expect(host.snapshot().state).toBe('ready')
      expect(observed.starts).toBe(starts)
      expect(observed.disposals).toBe(disposals)
    } finally {
      observed.activity = { runningTurns: 0, packageOperations: 0, runningTerminals: 0 }
      await host.stop()
    }
  })
})
