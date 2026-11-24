/**
 * Workspace binding: the activation resolves and stores one local `file:` root,
 * every launch input and view request reads that binding, and VS Code folder
 * changes surface an explicit rebind instead of drifting the page away from the
 * companion.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockFolder {
  readonly uri: { readonly scheme: string; readonly authority: string; readonly fsPath: string }
}

const observed = vi.hoisted(() => ({
  folders: undefined as readonly {
    readonly uri: { readonly scheme: string; readonly authority: string; readonly fsPath: string }
  }[] | undefined,
  listeners: [] as { listener: () => void; disposed: boolean }[],
  listenerDisposals: 0,
  warnings: [] as string[],
  warningActions: [] as string[][],
  errors: [] as string[],
  infos: [] as string[],
  starts: 0,
  disposals: 0,
  failNextStart: false,
}))

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return observed.folders },
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeWorkspaceFolders: (listener: () => void) => {
      const entry = { listener, disposed: false }
      observed.listeners.push(entry)
      return {
        dispose: () => {
          if (entry.disposed) return
          entry.disposed = true
          observed.listenerDisposals++
        },
      }
    },
  },
  l10n: {
    t: (message: string, params?: Record<string, string>) => Object.entries(params ?? {})
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), message),
  },
  window: {
    showWarningMessage: (message: string, ...actions: string[]) => {
      observed.warnings.push(message)
      observed.warningActions.push(actions)
      return Promise.resolve(undefined)
    },
    showErrorMessage: (message: string) => { observed.errors.push(message); return Promise.resolve(undefined) },
    showInformationMessage: (message: string) => { observed.infos.push(message); return Promise.resolve(undefined) },
  },
  commands: { executeCommand: async () => undefined },
}))

vi.mock('../src/host/companion-bridge.ts', () => ({
  resolveNodeExecutable: () => process.execPath,
  CompanionBridge: {
    start: async () => {
      if (observed.failNextStart) {
        observed.failNextStart = false
        throw new Error('dsh: the companion host exited during startup')
      }
      observed.starts++
      let disposed = false
      return {
        prepare: async () => ({ injections: [], assets: {}, shell: 'shell', styles: [] }),
        handle: async () => {},
        // No running work: these cases exercise the workspace binding, not the restart refusal.
        activity: async () => ({ runningTurns: 0, packageOperations: 0, runningTerminals: 0 }),
        dispose: async () => {
          if (disposed) return
          disposed = true
          observed.disposals++
        },
      }
    },
  },
}))

import { DshHost, compareWorkspaceFolders, resolveWorkspaceFolder } from '../src/host/host.ts'
import { reportWorkspaceChange, switchWorkspace, watchWorkspaceFolders } from '../src/extension.ts'

/** Isolated global storage: launch files are written below it on each start. */
const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-vscode-workspace-'))

afterAll(() => {
  delete process.env.DSH_VSCODE_SHARED_HOST
  rmSync(storageRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // The per-window companion is the fallback; this suite pins it explicitly.
  process.env.DSH_VSCODE_SHARED_HOST = '0'
  observed.folders = undefined
  observed.listeners = []
  observed.listenerDisposals = 0
  observed.warnings = []
  observed.warningActions = []
  observed.errors = []
  observed.infos = []
  observed.starts = 0
  observed.disposals = 0
  observed.failNextStart = false
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

/**
 * @param scheme - URI scheme.
 * @param authority - URI authority.
 * @param fsPath - local path.
 * @returns one workspace folder as VS Code reports it.
 */
function folder(scheme: string, authority: string, fsPath: string): MockFolder {
  return { uri: { scheme, authority, fsPath } }
}

/** @returns the extension host surface these suites drive. */
function newHost(): DshHost {
  return new DshHost(extension as never, () => {})
}

/** A view whose repaint this suite can observe. */
function viewDouble() {
  // A switch closes the page transport before stopping the host, then repaints.
  return { refresh: vi.fn(async () => {}), freezeTransport: vi.fn(async () => {}) }
}

/** A guard that reports no running work. */
function idleGuard() {
  return { blockers: () => [] as string[] }
}

/**
 * A host double for the extension-level checks: it binds the first open folder
 * on restart and can fail one launch.
 * @param bound - the binding before the restart.
 * @param failRestart - whether the next restart throws instead of binding.
 * @returns the host double and its mutable state.
 */
function hostDouble(bound: string, failRestart = false) {
  const state = { binding: bound as string | undefined, status: 'ready' as string }
  const host = {
    observeWorkspaceFolders: () => compareWorkspaceFolders(state.binding, observed.folders),
    get workspaceBinding() { return state.binding },
    snapshot: () => ({ state: state.status, mode: 'companion', detail: '', services: [] }),
    restart: vi.fn(async () => {
      if (failRestart) {
        state.status = 'failed'
        throw new Error('dsh: the companion host exited during startup')
      }
      state.binding = observed.folders?.[0]?.uri.fsPath
      state.status = 'ready'
    }),
  }
  return { host, state }
}

describe('resolveWorkspaceFolder', () => {
  it('accepts a local file: folder', () => {
    expect(resolveWorkspaceFolder([folder('file', '', 'E:\\work\\project')])).toBe('E:\\work\\project')
  })

  it('refuses a vscode-remote workspace and names its scheme', () => {
    const remote = (): string => resolveWorkspaceFolder([folder('vscode-remote', 'ssh-remote+host', '/srv/project')])
    expect(remote).toThrow(/unsupported workspace folder scheme "vscode-remote"/u)
    expect(remote).toThrow(/local file: folders/u)
  })

  it('refuses a memfs workspace', () => {
    expect(() => resolveWorkspaceFolder([folder('memfs', '', '/virtual/project')]))
      .toThrow(/unsupported workspace folder scheme "memfs"/u)
  })

  it('accepts a UNC share as a local file: folder', () => {
    expect(resolveWorkspaceFolder([folder('file', 'server', '//server/share')])).toBe('//server/share')
  })

  it('keeps the open-folder message when no folder is open', () => {
    expect(() => resolveWorkspaceFolder(undefined)).toThrow('dsh: open a VS Code folder before starting DSH')
    expect(() => resolveWorkspaceFolder([])).toThrow('dsh: open a VS Code folder before starting DSH')
  })
})

describe('compareWorkspaceFolders', () => {
  it('treats a root added after the unchanged first root as no change', () => {
    const change = compareWorkspaceFolders('E:\\work\\one', [
      folder('file', '', 'E:\\work\\one'),
      folder('file', '', 'E:\\work\\two'),
    ])
    expect(change.current).toBe('E:\\work\\one')
    expect(change.folders).toBe(2)
    expect(change.changed).toBe(false)
    expect(change.removed).toBe(false)
    expect(change.refusal).toBeUndefined()
  })

  it('treats a deleted first root as a change with a removed binding', () => {
    const change = compareWorkspaceFolders('E:\\work\\one', [folder('file', '', 'E:\\work\\two')])
    expect(change.current).toBe('E:\\work\\two')
    expect(change.changed).toBe(true)
    expect(change.removed).toBe(true)
  })

  it('treats a reordered first root as a change that keeps the old root open', () => {
    const change = compareWorkspaceFolders('E:\\work\\one', [
      folder('file', '', 'E:\\work\\two'),
      folder('file', '', 'E:\\work\\one'),
    ])
    expect(change.current).toBe('E:\\work\\two')
    expect(change.changed).toBe(true)
    expect(change.removed).toBe(false)
  })

  it('treats every folder closed as a change with a removed binding', () => {
    for (const folders of [undefined, []]) {
      const change = compareWorkspaceFolders('E:\\work\\one', folders)
      expect(change.current).toBeUndefined()
      expect(change.changed).toBe(true)
      expect(change.removed).toBe(true)
    }
  })

  it('refuses a non-file first root without claiming it was bound', () => {
    const change = compareWorkspaceFolders('E:\\work\\one', [
      folder('vscode-remote', 'ssh-remote+host', '/srv/project'),
    ])
    expect(change.refusal).toMatch(/unsupported workspace folder scheme "vscode-remote"/u)
    expect(change.current).toBeUndefined()
    expect(change.changed).toBe(true)
  })
})

describe('DshHost workspace binding', () => {
  it('binds the folder at start and keeps that binding after the folders change', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const host = newHost()
    await host.start()
    expect(host.workspaceBinding).toBe('E:\\work\\one')
    expect(host.cwd).toBe('E:\\work\\one')
    expect(host.workspacePath).toBe('E:\\work\\one')
    await host.createBridge(webview)

    observed.folders = [folder('file', '', 'E:\\work\\two')]
    expect(host.cwd).toBe('E:\\work\\one')
    expect(host.workspacePath).toBe('E:\\work\\one')
    expect(host.workspaceBinding).toBe('E:\\work\\one')

    await host.stop()
  })

  it('refuses a remote first folder at start and reports failed without a binding', async () => {
    observed.folders = [folder('vscode-remote', 'ssh-remote+host', '/srv/project')]
    const host = newHost()
    await expect(host.start()).rejects.toThrow(/vscode-remote/u)
    expect(host.snapshot().state).toBe('failed')
    expect(host.workspaceBinding).toBeUndefined()
    expect(() => host.cwd).toThrow(/has not bound a workspace folder/u)
  })

  it('refuses work that depends on a removed binding and names the recovery path', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const host = newHost()
    await host.start()
    await host.createBridge(webview)

    observed.folders = []
    expect(host.observeWorkspaceFolders().removed).toBe(true)
    expect(() => host.cwd).toThrow(/E:\\work\\one is no longer open/u)
    expect(() => host.workspacePath).toThrow(/restart DSH to bind the open folder/u)
    expect((await host.diagnostics()).cwd).toBe('E:\\work\\one (no longer open)')

    await host.stop()
  })

  it('refuses a restart with no open folder before stopping the running application', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const host = newHost()
    await host.start()
    await host.createBridge(webview)

    observed.folders = []
    await expect(host.restart()).rejects.toThrow(/open a VS Code folder before starting DSH/u)
    expect(host.snapshot().state).toBe('ready')
    expect(host.workspaceBinding).toBe('E:\\work\\one')

    await host.stop()
  })

  it('updates the binding and the launch inputs after a successful switch', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const host = newHost()
    await host.start()
    await host.createBridge(webview)
    expect(observed.starts).toBe(1)

    observed.folders = [folder('file', '', 'E:\\work\\two')]
    expect(host.observeWorkspaceFolders().changed).toBe(true)
    await host.restart()
    expect(host.workspaceBinding).toBe('E:\\work\\one')
    await host.createBridge(webview)

    expect(host.workspaceBinding).toBe('E:\\work\\two')
    expect(host.cwd).toBe('E:\\work\\two')
    expect(host.snapshot().state).toBe('ready')
    expect(observed.starts).toBe(2)

    await host.stop()
  })

  it('keeps the previous binding and reports failed when the new launch fails', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const host = newHost()
    await host.start()
    await host.createBridge(webview)

    observed.folders = [folder('file', '', 'E:\\work\\two')]
    observed.failNextStart = true
    await host.restart()
    await expect(host.createBridge(webview)).rejects.toThrow('exited during startup')

    expect(host.workspaceBinding).toBe('E:\\work\\one')
    expect(host.cwd).toBe('E:\\work\\one')
    expect(host.snapshot().state).toBe('failed')

    await host.stop()
  })
})

describe('extension workspace reporting', () => {
  it('reports no notice when a root is added after the unchanged first root', async () => {
    observed.folders = [
      folder('file', '', 'E:\\work\\one'),
      folder('file', '', 'E:\\work\\two'),
    ]
    const { host } = hostDouble('E:\\work\\one')
    await reportWorkspaceChange({ dsh: host as never, view: viewDouble() as never, guard: idleGuard(), log: () => {} })
    expect(observed.warnings).toEqual([])
    expect(host.restart).not.toHaveBeenCalled()
  })

  it('shows a pending rebind naming both roots and never restarts on its own', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    const { host } = hostDouble('E:\\work\\one')
    await reportWorkspaceChange({ dsh: host as never, view: viewDouble() as never, guard: idleGuard(), log: () => {} })
    expect(observed.warnings).toHaveLength(1)
    expect(observed.warnings[0]).toContain('E:\\work\\one')
    expect(observed.warnings[0]).toContain('E:\\work\\two')
    expect(observed.warningActions[0]).toContain('Restart DSH')
    expect(host.restart).not.toHaveBeenCalled()
  })

  it('reports a changed first root without offering a switch while a turn runs', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    const { host } = hostDouble('E:\\work\\one')
    await reportWorkspaceChange({
      dsh: host as never,
      view: viewDouble() as never,
      guard: { blockers: () => ['a running turn'] },
      log: () => {},
    })
    expect(observed.warnings[0]).toContain('a running turn')
    expect(observed.warningActions[0]).not.toContain('Restart DSH')
    expect(host.restart).not.toHaveBeenCalled()
  })

  it('reports a closed bound root with the recovery path', async () => {
    observed.folders = []
    const { host } = hostDouble('E:\\work\\one')
    await reportWorkspaceChange({ dsh: host as never, view: viewDouble() as never, guard: idleGuard(), log: () => {} })
    expect(observed.warnings).toHaveLength(1)
    expect(observed.warnings[0]).toContain('E:\\work\\one')
    expect(observed.warnings[0]).toContain('DSH: Restart Host')
    expect(host.restart).not.toHaveBeenCalled()
  })

  it('refuses a switch while a turn is running and leaves the restart untouched', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    const { host } = hostDouble('E:\\work\\one')
    await expect(switchWorkspace({
      dsh: host as never,
      view: viewDouble() as never,
      guard: { blockers: () => ['a running turn'] },
      log: () => {},
    })).rejects.toThrow('a running turn')
    expect(host.restart).not.toHaveBeenCalled()
    expect(observed.errors[0]).toContain('cannot switch the workspace')
    expect(observed.infos).toEqual([])
  })

  it('updates the binding and repaints after a successful switch', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    const { host } = hostDouble('E:\\work\\one')
    const view = viewDouble()
    await switchWorkspace({ dsh: host as never, view: view as never, guard: idleGuard(), log: () => {} })
    expect(host.workspaceBinding).toBe('E:\\work\\two')
    expect(view.refresh).toHaveBeenCalledOnce()
    expect(observed.infos).toEqual(['DSH now uses E:\\work\\two.'])
  })

  it('keeps the previous binding and reports the failure when the switch cannot launch', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    const { host } = hostDouble('E:\\work\\one', true)
    const view = viewDouble()
    await expect(switchWorkspace({ dsh: host as never, view: view as never, guard: idleGuard(), log: () => {} }))
      .rejects.toThrow('exited during startup')
    expect(host.workspaceBinding).toBe('E:\\work\\one')
    // The switch closed the page transport before stopping; the failure path repaints a live page.
    expect(view.refresh).toHaveBeenCalledOnce()
    expect(observed.errors[0]).toContain('DSH could not switch to E:\\work\\two')
    expect(observed.errors[0]).toContain('E:\\work\\one')
    expect(observed.infos).toEqual([])
  })
})

describe('watchWorkspaceFolders', () => {
  it('reports a folder change through the subscribed listener', async () => {
    observed.folders = [folder('file', '', 'E:\\work\\one')]
    const { host } = hostDouble('E:\\work\\one')
    const subscription = watchWorkspaceFolders({
      dsh: host as never,
      view: viewDouble() as never,
      guard: idleGuard(),
      log: () => {},
      repaint: () => {},
    })
    observed.folders = [folder('file', '', 'E:\\work\\two')]
    observed.listeners[0]?.listener()
    await vi.waitFor(() => { expect(observed.warnings).toHaveLength(1) })
    subscription.dispose()
  })

  it('disposes the folder-change listener with the extension subscription', () => {
    const { host } = hostDouble('E:\\work\\one')
    const subscription = watchWorkspaceFolders({
      dsh: host as never,
      view: viewDouble() as never,
      guard: idleGuard(),
      log: () => {},
    })
    expect(observed.listeners).toHaveLength(1)
    subscription.dispose()
    expect(observed.listeners[0]?.disposed).toBe(true)
    expect(observed.listenerDisposals).toBe(1)
  })
})
