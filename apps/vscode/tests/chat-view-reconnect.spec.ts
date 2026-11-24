/**
 * Automatic recovery of the page after the shared host disconnects: the view
 * retries with backoff, rebuilds the shell when the host returns, keeps backing
 * off while it stays down, and stops retrying after a deliberate stop.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    parse: (value: string) => ({ scheme: value.split(':')[0] ?? '', value }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => true },
  l10n: { t: (message: string) => message },
  window: {
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: () => undefined,
      inspect: () => undefined,
      update: async () => {},
    }),
  },
}))

import { DshChatView } from '../src/view/chat-view.ts'

/** Webview surface the view binds; it records the document written. */
function webviewSurface() {
  const webview = {
    html: '',
    options: {} as unknown,
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview:${uri.fsPath}` }),
    postMessage: async () => true,
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  }
  return {
    view: { webview, onDidDispose: () => ({ dispose: () => {} }) },
    html: () => webview.html,
  }
}

/** Host whose state, revision, and bridge failures the test controls. */
function controllableHost() {
  const listeners = new Set<() => void>()
  let state: 'ready' | 'starting' | 'failed' | 'stopped' = 'ready'
  let revision = 1
  let builds = 0
  let failures = 0
  const emit = (): void => { for (const listener of [...listeners]) listener() }
  const host = {
    get revision(): number {
      return revision
    },
    shellRoot: 'C:/shell',
    storageDir: 'C:/storage',
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: async () => {
      if (state === 'ready') return
      state = 'starting'
      emit()
    },
    snapshot: () => ({
      state,
      mode: 'companion',
      detail: state === 'failed' ? 'DSH shared host connection ended: the host closed the connection' : '',
      services: [],
    }),
    createBridge: async () => {
      builds++
      if (failures > 0) {
        failures--
        state = 'failed'
        emit()
        throw new Error('dsh: the shared DSH host is not reachable')
      }
      revision++
      state = 'ready'
      const bridge = {
        prepare: async () => ({ injections: [], assets: {}, shell: '/shell.js', styles: [] }),
        handle: async () => {},
        dispose: async () => {},
      }
      emit()
      return bridge
    },
  }
  return {
    host,
    builds: () => builds,
    fail: () => {
      state = 'failed'
      emit()
    },
    stop: () => {
      state = 'stopped'
      emit()
    },
    failNextBuilds: (count: number) => { failures = count },
  }
}

/**
 * @returns a bound view over the controllable host.
 */
async function bind() {
  const fixture = controllableHost()
  const surface = webviewSurface()
  const view = new DshChatView(
    { fsPath: 'C:/extension' } as never,
    fixture.host as never,
    () => {},
    {} as never,
  )
  view.resolveWebviewView(surface.view as never)
  await view.refresh()
  expect(surface.html()).toContain('__DSH_BOOT_PAYLOAD__')
  return { fixture, surface, view }
}

describe('DshChatView automatic reconnect', () => {
  it('rebuilds the shell after the host reconnects', async () => {
    const { fixture, surface } = await bind()
    fixture.fail()
    expect(surface.html()).not.toContain('__DSH_BOOT_PAYLOAD__')
    await vi.waitFor(() => { expect(surface.html()).toContain('__DSH_BOOT_PAYLOAD__') }, { timeout: 3_000 })
    expect(fixture.builds()).toBe(2)
  })

  it('keeps backing off while the host stays down, then recovers', async () => {
    const { fixture, surface } = await bind()
    fixture.failNextBuilds(1)
    fixture.fail()
    // First attempt after 500 ms fails, the next one is one second later.
    await vi.waitFor(() => { expect(fixture.builds()).toBe(2) }, { timeout: 2_000 })
    expect(surface.html()).not.toContain('__DSH_BOOT_PAYLOAD__')
    await vi.waitFor(() => { expect(surface.html()).toContain('__DSH_BOOT_PAYLOAD__') }, { timeout: 5_000 })
    expect(fixture.builds()).toBe(3)
  })

  it('stops retrying after a deliberate stop', async () => {
    const { fixture, surface } = await bind()
    fixture.stop()
    await new Promise<void>((resolve) => { setTimeout(resolve, 800) })
    expect(fixture.builds()).toBe(1)
    expect(surface.html()).not.toContain('__DSH_BOOT_PAYLOAD__')
  })
})
