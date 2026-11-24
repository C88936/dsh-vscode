/**
 * The webview view's page requests: the Plugins page's restart request runs the extension's own
 * restart command, a refused command answers visibly instead of silently, and no other page
 * message is treated as a restart.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const native = vi.hoisted(() => ({
  executed: [] as string[],
  errors: [] as string[],
  warnings: [] as string[],
  /** Global configuration writes the view performed, in order. */
  updated: [] as { key: string; value: unknown; target: unknown }[],
  /** The failure a configuration update reports instead of saving. */
  updateFailure: '',
  /** Whether the restart command is registered in this fixture. */
  restartAvailable: true,
  /** The failure the registered restart command reports instead of restarting. */
  restartFailure: '',
  /** The choice the warning prompt returns. */
  warningChoice: undefined as string | undefined,
  /** Status bar items the view created, in order. */
  statusItems: [] as { text: string; tooltip?: string; command?: string; shown: boolean; disposed: boolean }[],
}))

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
    parse: (value: string) => ({ scheme: value.split(':')[0] ?? '', value }),
  },
  Range: class {
    constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {}
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: {
    executeCommand: async (command: string) => {
      if (command === 'dsh.restart' && !native.restartAvailable) throw new Error(`command '${command}' not found`)
      if (command === 'dsh.restart' && native.restartFailure !== '') throw new Error(native.restartFailure)
      native.executed.push(command)
      return undefined
    },
  },
  env: { openExternal: async () => true },
  l10n: { t: (message: string) => message },
  window: {
    showErrorMessage: (message: string) => { native.errors.push(message); return Promise.resolve(undefined) },
    showWarningMessage: (message: string) => { native.warnings.push(message); return Promise.resolve(native.warningChoice) },
    showInformationMessage: () => Promise.resolve(undefined),
    createStatusBarItem: () => {
      const item = {
        text: '', tooltip: undefined as string | undefined, command: undefined as string | undefined,
        shown: false, disposed: false,
        show() { this.shown = true },
        dispose() { this.disposed = true },
      }
      native.statusItems.push(item)
      return item
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      // The effective value is the last write; `inspect` reports overrides.
      get: (key: string) => [...native.updated].reverse().find(item => item.key === key)?.value,
      inspect: () => undefined,
      update: async (key: string, value: unknown, target: unknown) => {
        if (native.updateFailure !== '') throw new Error(native.updateFailure)
        native.updated.push({ key, value, target })
      },
    }),
  },
}))

import { DshChatView } from '../src/view/chat-view.ts'

/** One frame the view delivered to the page. */
interface PostedFrame {
  readonly type: string
  readonly id?: number
  readonly ok?: boolean
  readonly error?: string
}

/** The webview surface the view binds; it records listener and frames. */
function webviewSurface() {
  const posted: PostedFrame[] = []
  let listener: ((message: unknown) => void) | undefined
  const webview = {
    html: '',
    options: {} as unknown,
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview:${uri.fsPath}` }),
    postMessage: async (message: PostedFrame) => { posted.push(message); return true },
    onDidReceiveMessage: (next: (message: unknown) => void) => { listener = next; return { dispose: () => {} } },
  }
  const view = {
    webview,
    onDidDispose: () => ({ dispose: () => {} }),
  }
  return {
    view,
    posted,
    send: (message: unknown) => { listener?.(message) },
    bound: () => listener !== undefined,
  }
}

/** A host that is already ready and needs no companion process. */
function readyHost(configMismatch = false, model: { provider: string; model: string; configured: boolean } = { provider: 'company', model: 'qwen-max', configured: true }) {
  return {
    revision: 1,
    configMismatch,
    shellRoot: 'C:/shell',
    storageDir: 'C:/storage',
    onChange: () => () => {},
    start: async () => {},
    snapshot: () => ({ state: 'ready', mode: 'companion', detail: '', services: [] }),
    modelConfig: async () => model,
    createBridge: async () => ({
      prepare: async () => ({ injections: [], assets: {}, shell: '/shell.js', styles: [] }),
      handle: async () => {},
      dispose: async () => {},
    }),
  }
}

async function bind() {
  const surface = webviewSurface()
  const view = new DshChatView({ fsPath: 'C:/extension' } as never, readyHost() as never, () => {}, {} as never)
  view.resolveWebviewView(surface.view as never)
  await view.refresh()
  expect(surface.bound()).toBe(true)
  return { view, surface }
}

describe('DshChatView page requests', () => {
  it('answers an oversized diff request so the page can recover', async () => {
    const { surface } = await bind()
    surface.send({ type: 'open-diff', id: 87, request: { title: 'large.ts', before: 'a'.repeat(4_000_000), after: 'b' } })
    await vi.waitFor(() => expect(surface.posted).toContainEqual({
      type: 'open-result', id: 87, ok: false, error: 'This comparison is too large to open in the editor.',
    }))
  })

  it('shows the running host model in the status bar', async () => {
    native.statusItems.length = 0
    native.warnings.length = 0
    const surface = webviewSurface()
    const view = new DshChatView({ fsPath: 'C:/extension' } as never, readyHost(false, { provider: 'company', model: 'qwen-max', configured: true }) as never, () => {}, {} as never)
    view.resolveWebviewView(surface.view as never)
    await view.refresh()
    await vi.waitFor(() => { expect(native.statusItems.at(-1)?.text).toBe('DSH: company/qwen-max') })
    expect(native.statusItems.at(-1)?.shown).toBe(true)
    expect(native.statusItems.at(-1)?.command).toBe('dsh.selectModel')
    expect(surface.view.description).toBe('DSH: company/qwen-max')
    expect(native.warnings).toEqual([])
  })

  it('offers model selection as the first action when the host has no model', async () => {
    native.statusItems.length = 0
    native.warnings.length = 0
    native.executed.length = 0
    native.warningChoice = 'Select a model'
    onTestFinished(() => { native.warningChoice = undefined })
    const surface = webviewSurface()
    const view = new DshChatView({ fsPath: 'C:/extension' } as never, readyHost(false, { provider: 'company', model: '', configured: false }) as never, () => {}, {} as never)
    view.resolveWebviewView(surface.view as never)
    await view.refresh()
    await vi.waitFor(() => { expect(native.warnings).toHaveLength(1) })
    await vi.waitFor(() => { expect(native.executed).toContain('dsh.selectModel') })
  })

  it('offers the company setup once when the host has no model', async () => {
    native.statusItems.length = 0
    native.warnings.length = 0
    native.executed.length = 0
    native.warningChoice = 'Configure company endpoint'
    onTestFinished(() => { native.warningChoice = undefined })
    const surface = webviewSurface()
    const view = new DshChatView({ fsPath: 'C:/extension' } as never, readyHost(false, { provider: 'company', model: '', configured: false }) as never, () => {}, {} as never)
    view.resolveWebviewView(surface.view as never)
    await view.refresh()
    await vi.waitFor(() => { expect(native.statusItems.at(-1)?.text).toBe('DSH: no model configured') })
    await vi.waitFor(() => { expect(native.warnings).toHaveLength(1) })
    await vi.waitFor(() => { expect(native.executed).toContain('dsh.configureCompany') })
  })

  it('runs the existing restart command and answers the page', async () => {
    native.executed.length = 0
    const { surface } = await bind()
    surface.send({ type: 'restart-host', id: 7 })
    await vi.waitFor(() => { expect(native.executed).toEqual(['dsh.restart']) })
    await vi.waitFor(() => { expect(surface.posted).toContainEqual({ type: 'restart-result', id: 7, ok: true }) })
  })

  it('answers a refused restart visibly instead of silently', async () => {
    native.executed.length = 0
    native.errors.length = 0
    native.restartAvailable = false
    onTestFinished(() => { native.restartAvailable = true })
    const { surface } = await bind()
    surface.send({ type: 'restart-host', id: 9 })
    await vi.waitFor(() => { expect(native.errors).toHaveLength(1) })
    expect(native.errors[0]).toContain('did not restart')
    await vi.waitFor(() => {
      expect(surface.posted).toContainEqual({
        type: 'restart-result', id: 9, ok: false, error: expect.stringContaining('did not restart'),
      })
    })
  })

  it('answers a busy refusal with the command error and no success', async () => {
    native.executed.length = 0
    native.errors.length = 0
    native.restartFailure = 'DSH cannot restart while a running turn is running. Stop it and try again.'
    onTestFinished(() => { native.restartFailure = '' })
    const { surface } = await bind()
    surface.send({ type: 'restart-host', id: 11 })
    await vi.waitFor(() => {
      expect(surface.posted).toContainEqual({
        type: 'restart-result', id: 11, ok: false, error: expect.stringContaining('a running turn'),
      })
    })
    expect(native.errors[0]).toContain('a running turn')
  })

  it('ignores a restart request without an integer id', async () => {
    native.executed.length = 0
    const { surface } = await bind()
    surface.send({ type: 'restart-host', id: 'seven' })
    surface.send({ type: 'restart-host' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(native.executed).not.toContain('dsh.restart')
  })
})

describe('DshChatView deployment model saves', () => {
  it('writes the trimmed model to global dsh.llmModel and answers saved', async () => {
    native.updated.length = 0
    const { surface } = await bind()
    surface.send({ type: 'set-provider-model', id: 21, model: '  company-model  ' })
    await vi.waitFor(() => {
      expect(native.updated).toEqual([{ key: 'llmModel', value: 'company-model', target: 1 }])
    })
    await vi.waitFor(() => {
      expect(surface.posted).toContainEqual({ type: 'set-provider-model-result', id: 21, ok: true })
    })
    // Only the carrier setting is written: the profile is not this hook's to save.
    expect(native.updated.map(entry => entry.key)).toEqual(['llmModel'])
  })

  it('refuses empty, invalid, and placeholder ids without writing configuration', async () => {
    native.updated.length = 0
    native.warnings.length = 0
    const { surface } = await bind()
    const invalid = ['', '   ', 'line\nbreak', 'dsh-unconfigured-model', 'm'.repeat(201)]
    invalid.forEach((model, index) => { surface.send({ type: 'set-provider-model', id: 30 + index, model }) })
    await vi.waitFor(() => { expect(native.warnings).toHaveLength(invalid.length) })
    expect(native.updated).toEqual([])
    for (let index = 0; index < invalid.length; index++) {
      await vi.waitFor(() => {
        expect(surface.posted).toContainEqual(expect.objectContaining({
          type: 'set-provider-model-result',
          id: 30 + index,
          ok: false,
        }))
      })
    }
  })

  it('answers failed when the configuration update is refused', async () => {
    native.updated.length = 0
    native.errors.length = 0
    native.updateFailure = 'settings are locked'
    onTestFinished(() => { native.updateFailure = '' })
    const { surface } = await bind()
    surface.send({ type: 'set-provider-model', id: 41, model: 'company-model' })
    await vi.waitFor(() => { expect(native.errors).toHaveLength(1) })
    expect(native.errors[0]).toContain('could not be saved')
    await vi.waitFor(() => {
      expect(surface.posted).toContainEqual(expect.objectContaining({
        type: 'set-provider-model-result',
        id: 41,
        ok: false,
        error: expect.stringContaining('could not be saved'),
      }))
    })
  })

  it('ignores a model request without a string id', async () => {
    native.updated.length = 0
    const { surface } = await bind()
    surface.send({ type: 'set-provider-model', id: 51 })
    surface.send({ type: 'set-provider-model', id: 52, model: 7 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(native.updated).toEqual([])
    expect(surface.posted.some(frame => frame.type === 'set-provider-model-result')).toBe(false)
  })

  it('offers the shared restart when the host booted another window settings', async () => {
    native.warnings.length = 0
    native.executed.length = 0
    native.warningChoice = 'Restart DSH'
    onTestFinished(() => { native.warningChoice = undefined })
    const surface = webviewSurface()
    const view = new DshChatView(
      { fsPath: 'C:/extension' } as never,
      readyHost(true) as never,
      () => {},
      {} as never,
    )
    view.resolveWebviewView(surface.view as never)
    await view.refresh()
    await vi.waitFor(() => { expect(native.warnings).toHaveLength(1) })
    expect(native.warnings[0]).toContain('different deployment settings')
    await vi.waitFor(() => { expect(native.executed).toEqual(['dsh.restart']) })
  })
})
