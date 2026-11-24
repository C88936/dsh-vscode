/**
 * Shared-host mode of the extension: one window starts the detached host,
 * another attaches without starting a second one, activity is host-wide,
 * stopping closes only this window's connection, and an unexpected disconnect
 * reports the shared host as failed.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scenario = vi.hoisted(() => ({
  starts: 0,
  attaches: 0,
  disposals: 0,
  hostRunning: false,
  shutdownCalls: 0,
  hostFingerprint: 'host-config',
  localPlugins: undefined as { id: string; path: string }[] | undefined,
  shutdownAnswer: { ok: true } as { ok: boolean; error?: string },
  activity: { runningTurns: 0, packageOperations: 0, runningTerminals: 0 },
  onExit: undefined as ((reason: string) => void) | undefined,
  onMaintenance: undefined as ((active: boolean, reason?: string) => void) | undefined,
  startOptions: undefined as { launchDir?: string; modelConfig?: unknown } | undefined,
  attachOptions: undefined as {
    configFingerprint: string
    runInTerminal?: unknown
    openFile?: unknown
    onMaintenance?: (active: boolean, reason?: string) => void
  } | undefined,
}))

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: 'E:/workspace' } }],
    getConfiguration: () => ({ get: (key: string) => key === 'localPlugins' ? scenario.localPlugins : undefined }),
  },
}))

vi.mock('../src/host/shared-host-process.ts', () => ({
  startSharedHostProcess: async (options: { launchDir?: string }) => {
    scenario.starts++
    scenario.startOptions = options
    scenario.hostRunning = true
    return { pid: 4242 }
  },
  attachSharedHost: async (options: {
    configFingerprint: string
    onExit?: (reason: string) => void
    onMaintenance?: (active: boolean, reason?: string) => void
    runInTerminal?: unknown
    openFile?: unknown
  }) => {
    scenario.attaches++
    if (!scenario.hostRunning) throw new Error('dsh: the shared DSH host is not reachable')
    scenario.onExit = options.onExit
    scenario.onMaintenance = options.onMaintenance
    scenario.attachOptions = options
    let disposed = false
    return {
      hello: { configFingerprint: scenario.hostFingerprint },
      prepare: async () => ({ injections: [], assets: {}, shell: 'shell', styles: [] }),
      handle: async () => {},
      activity: async () => scenario.activity,
      modelConfig: async () => ({ provider: 'company', model: 'qwen-max', configured: true }),
      shutdownHost: async () => {
        scenario.shutdownCalls++
        if (scenario.shutdownAnswer.ok) scenario.hostRunning = false
        return { ...scenario.shutdownAnswer }
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        scenario.disposals++
      },
    }
  },
}))

import { DshHost } from '../src/host/host.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  scenario.starts = 0
  scenario.attaches = 0
  scenario.disposals = 0
  scenario.hostRunning = false
  scenario.shutdownCalls = 0
  scenario.hostFingerprint = 'host-config'
  scenario.localPlugins = undefined
  scenario.shutdownAnswer = { ok: true }
  scenario.onExit = undefined
  scenario.activity = { runningTurns: 0, packageOperations: 0, runningTerminals: 0 }
  delete process.env.DSH_VSCODE_SHARED_HOST
})

/**
 * @returns one extension root with the shipped overlay and built shell.
 */
function extensionRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-mode-'))
  roots.push(root)
  mkdirSync(join(root, 'extension', 'profile'), { recursive: true })
  writeFileSync(join(root, 'extension', 'profile', 'vscode.patch.yml'), '# shipped overlay\n')
  mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
  writeFileSync(join(root, 'extension', 'dist', 'index.html'), '<div id="root"></div>\n')
  mkdirSync(join(root, 'storage'), { recursive: true })
  return root
}

/**
 * @param root - extension root.
 * @returns the extension context the host reads.
 */
function context(root: string, version = 'test'): object {
  return {
    extensionUri: { fsPath: join(root, 'extension') },
    globalStorageUri: { fsPath: join(root, 'storage') },
    extension: { packageJSON: { version } },
  }
}

const webview = { asUri: (path: string) => path, postMessage: async () => true }

/**
 * @param root - extension root.
 * @returns a host in shared mode.
 */
function sharedHost(root: string): DshHost {
  process.env.DSH_VSCODE_SHARED_HOST = '1'
  return new DshHost(context(root) as never, () => {})
}

/**
 * @param root - extension root.
 * @returns a host with no mode variable set.
 */
function defaultHost(root: string): DshHost {
  delete process.env.DSH_VSCODE_SHARED_HOST
  return new DshHost(context(root) as never, () => {})
}

describe('DshHost shared mode', () => {
  it('reports a different plugin path or extension version on the same running Host', async () => {
    const root = extensionRoot()
    const plugin = join(root, 'plugin.mjs')
    writeFileSync(plugin, 'export default {}\n')
    scenario.localPlugins = [{ id: 'fixture', path: plugin }]
    const first = sharedHost(root)
    await first.start()
    await first.createBridge(webview)
    scenario.hostFingerprint = scenario.attachOptions!.configFingerprint

    const same = sharedHost(root)
    await same.start()
    await same.createBridge(webview)
    expect(same.configMismatch).toBe(false)

    scenario.localPlugins = [{ id: 'fixture', path: join(root, 'another-plugin.mjs') }]
    const other = sharedHost(root)
    await other.start()
    await other.createBridge(webview)
    expect(other.configMismatch).toBe(true)

    scenario.localPlugins = [{ id: 'fixture', path: plugin }]
    const upgraded = new DshHost(context(root, 'next-version') as never, () => {})
    await upgraded.start()
    await upgraded.createBridge(webview)
    expect(upgraded.configMismatch).toBe(true)
    expect(scenario.starts).toBe(1)
    await Promise.all([first.stop(), same.stop(), other.stop(), upgraded.stop()])
  })

  it('boots the host from host-owned launch files and keeps them when a window leaves', async () => {
    const root = extensionRoot()
    const host = sharedHost(root)
    await host.start()
    await host.createBridge(webview)
    const launchDir = scenario.startOptions?.launchDir
    expect(launchDir).toBeDefined()
    // The files the host boots from live below the storage, not in the window
    // that happened to start it.
    expect(launchDir?.startsWith(join(root, 'storage', 'shared-launch'))).toBe(true)
    expect(existsSync(launchDir ?? '')).toBe(true)
    // The shared host runs this window's tools, so the attach carries both
    // VS Code runners.
    expect(scenario.attachOptions?.runInTerminal).toBeTypeOf('function')
    expect(scenario.attachOptions?.openFile).toBeTypeOf('function')

    await host.stop()
    // Closing the starting window must not take the host's files away.
    expect(existsSync(launchDir ?? '')).toBe(true)

    // A later start replaces the host-owned root and uses a fresh directory.
    scenario.hostRunning = false
    scenario.startOptions = undefined
    await host.start()
    await host.createBridge(webview)
    expect(scenario.startOptions?.launchDir).not.toBe(launchDir)
    await host.stop()
  })

  it('reports the shared host maintenance admission to the window', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    expect(host.maintenancePending).toBe(false)
    scenario.onMaintenance?.(true, 'a window requested a maintenance restart')
    expect(host.maintenancePending).toBe(true)
    scenario.onMaintenance?.(false)
    expect(host.maintenancePending).toBe(false)
    await host.stop()
  })

  it('reports the deployment model configuration the shared host answers with', async () => {
    const root = extensionRoot()
    const host = sharedHost(root)
    await host.start()
    await host.createBridge(webview)
    // The launcher passes what this window would boot; the running host is the authority.
    expect(scenario.startOptions?.modelConfig).toEqual({ provider: 'deepseek-official', model: '', configured: true })
    await expect(host.modelConfig()).resolves.toEqual({ provider: 'company', model: 'qwen-max', configured: true })
    await host.stop()
  })

  it('starts the host for the first window and reports host-wide activity', async () => {
    scenario.activity = { runningTurns: 2, packageOperations: 1, runningTerminals: 3 }
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    expect(scenario.starts).toBe(1)
    // One failed attach before the lock, one re-check under it, and one after
    // the start; no second host is created.
    expect(scenario.attaches).toBe(3)
    expect(host.snapshot().state).toBe('ready')
    expect(host.configMismatch).toBe(true)
    expect(await host.companionActivity()).toEqual({ runningTurns: 2, packageOperations: 1, runningTerminals: 3 })

    await host.stop()
    expect(host.snapshot().state).toBe('stopped')
    expect(scenario.disposals).toBe(1)
    // A window leaving never stops the host other windows may use.
    expect(scenario.starts).toBe(1)
  })

  it('attaches a second window without starting another host', async () => {
    const root = extensionRoot()
    scenario.hostRunning = true
    const first = sharedHost(root)
    await first.start()
    await first.createBridge(webview)
    const second = sharedHost(root)
    await second.start()
    await second.createBridge(webview)
    expect(scenario.starts).toBe(0)
    expect(scenario.attaches).toBe(2)
    expect(first.snapshot().state).toBe('ready')
    expect(second.snapshot().state).toBe('ready')
    await first.stop()
    await second.stop()
    expect(scenario.disposals).toBe(2)
  })

  it('refuses a restart while the shared host reports work', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    scenario.activity = { runningTurns: 1, packageOperations: 0, runningTerminals: 0 }
    await expect(host.restart()).rejects.toThrow(/still reports 1 running turn/u)
    expect(scenario.disposals).toBe(0)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })

  it('reports an unexpected shared-host disconnect as failed', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    scenario.onExit?.('the shared DSH host at pipe closed the connection')
    expect(host.snapshot().state).toBe('failed')
    expect(host.snapshot().detail).toContain('shared host connection ended')
    await host.stop()
  })

  it('uses the shared host when no mode variable is set', async () => {
    scenario.hostRunning = true
    const host = defaultHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    expect(scenario.attaches).toBe(1)
    expect(scenario.starts).toBe(0)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })

  it('restarts the shared host through the shutdown request', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    await host.restart()
    expect(scenario.shutdownCalls).toBe(1)
    expect(scenario.disposals).toBe(1)
    expect(host.snapshot().state).toBe('starting')
    await host.createBridge(webview)
    // One start for the first window and one after the maintenance stop.
    expect(scenario.starts).toBe(2)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })

  it('keeps the shared host running when it refuses the maintenance stop', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    scenario.shutdownAnswer = { ok: false, error: 'DSH still reports 1 running turn; the shared host was not stopped.' }
    await expect(host.restart()).rejects.toThrow(/still reports 1 running turn/u)
    expect(scenario.shutdownCalls).toBe(1)
    expect(scenario.disposals).toBe(0)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })

  it('stops the shared host for an update handover without starting another', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    await host.stopHost()
    expect(scenario.shutdownCalls).toBe(1)
    expect(scenario.disposals).toBe(1)
    // No host was started after the stop: the reloaded window starts the
    // installed version instead of this process booting another old one.
    expect(scenario.starts).toBe(1)
    expect(host.snapshot().state).toBe('stopped')

    await host.start()
    await host.createBridge(webview)
    expect(scenario.starts).toBe(2)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })

  it('keeps the shared host running when the handover stop is refused', async () => {
    const host = sharedHost(extensionRoot())
    await host.start()
    await host.createBridge(webview)
    scenario.shutdownAnswer = { ok: false, error: 'DSH still reports 1 running turn; the shared host was not stopped.' }
    await expect(host.stopHost()).rejects.toThrow(/still reports 1 running turn/u)
    expect(scenario.shutdownCalls).toBe(1)
    expect(scenario.disposals).toBe(0)
    expect(host.snapshot().state).toBe('ready')
    await host.stop()
  })
})

