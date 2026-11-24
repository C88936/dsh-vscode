/**
 * Per-activation launch files: two VS Code windows that share one extension
 * global-storage location get separate launch directories, persistent paths do
 * not move, and a stop removes only the directory its own host allocated.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface StartRecord {
  readonly launchDir: string
  readonly storageDir: string
  readonly overlayPath: string
  readonly extraOverlays: readonly string[]
}

interface DisposalRecord {
  readonly launchDir: string
  readonly existedAtDispose: boolean
}

const scenario = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  starts: [] as StartRecord[],
  disposals: [] as DisposalRecord[],
  failNext: false,
}))

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: 'E:/workspace' } }],
    getConfiguration: () => ({ get: (key: string) => scenario.settings[key] }),
  },
}))

vi.mock('../src/host/companion-bridge.ts', () => ({
  resolveNodeExecutable: () => process.execPath,
  CompanionBridge: {
    start: async (options: {
      launchDir: string
      storageDir: string
      overlayPath: string
      extraOverlays?: readonly string[]
    }) => {
      scenario.starts.push({
        launchDir: options.launchDir,
        storageDir: options.storageDir,
        overlayPath: options.overlayPath,
        extraOverlays: [...options.extraOverlays ?? []],
      })
      if (scenario.failNext) {
        scenario.failNext = false
        throw new Error('dsh: the companion host exited during startup')
      }
      let disposed = false
      return {
        prepare: async () => ({ injections: [], assets: {}, shell: 'shell', styles: [] }),
        handle: async () => {},
        dispose: async () => {
          if (disposed) return
          disposed = true
          scenario.disposals.push({
            launchDir: options.launchDir,
            existedAtDispose: existsSync(options.launchDir),
          })
        },
      }
    },
  },
}))

import { DshHost } from '../src/host/host.ts'

const storages: string[] = []

/**
 * Create one extension root: its shipped overlay, and a shared global-storage
 * directory that two host instances can use at the same time.
 * @returns the extension root.
 */
function extensionRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-launch-'))
  storages.push(root)
  mkdirSync(join(root, 'extension', 'profile'), { recursive: true })
  writeFileSync(join(root, 'extension', 'profile', 'vscode.patch.yml'), '# shipped overlay\n')
  mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
  writeFileSync(join(root, 'extension', 'dist', 'index.html'), '<div id="root"></div>\n')
  return root
}

/**
 * @param root - extension root.
 * @returns the extension context the host reads.
 */
function context(root: string): object {
  return {
    extensionUri: { fsPath: join(root, 'extension') },
    globalStorageUri: { fsPath: join(root, 'storage') },
    extension: { packageJSON: { version: 'test' } },
  }
}

/** Settings that make each activation generate a provider overlay. */
function companySettings(model: string): Record<string, unknown> {
  return {
    providerMode: 'openai-compatible',
    llmBaseUrl: 'http://llm.lan:8000/v1',
    llmModel: model,
    providerRoute: 'company',
    llmApiKeyEnv: 'DSH_LLM_API_KEY',
  }
}

const webview = {
  asUri: (path: string) => path,
  postMessage: async () => true,
}

afterEach(() => {
  delete process.env.DSH_VSCODE_SHARED_HOST
  for (const root of storages.splice(0)) rmSync(root, { recursive: true, force: true })
  scenario.settings = {}
  scenario.starts = []
  scenario.disposals = []
  scenario.failNext = false
})

beforeEach(() => {
  // The per-window companion is the fallback; this suite pins it explicitly.
  process.env.DSH_VSCODE_SHARED_HOST = '0'
})

describe('launch directory isolation', () => {
  it('gives two activations different launch directories with their own overlays', async () => {
    const root = extensionRoot()
    const storage = join(root, 'storage')
    const first = new DshHost(context(root) as never, () => {})
    const second = new DshHost(context(root) as never, () => {})

    scenario.settings = companySettings('model-a')
    await first.start()
    await first.createBridge(webview)
    scenario.settings = companySettings('model-b')
    await second.start()
    await second.createBridge(webview)

    const [firstStart, secondStart] = scenario.starts
    expect(firstStart).toBeDefined()
    expect(secondStart).toBeDefined()
    const firstDir = firstStart?.launchDir ?? ''
    const secondDir = secondStart?.launchDir ?? ''
    expect(firstDir).not.toBe(secondDir)
    expect(dirname(firstDir)).toBe(join(storage, 'launch'))
    expect(dirname(secondDir)).toBe(join(storage, 'launch'))
    expect(first.launchDir).toBe(firstDir)
    expect(second.launchDir).toBe(secondDir)

    const firstPatch = readFileSync(join(firstDir, 'provider.patch.yml'), 'utf8')
    const secondPatch = readFileSync(join(secondDir, 'provider.patch.yml'), 'utf8')
    expect(firstPatch).toContain("model: 'model-a'")
    expect(secondPatch).toContain("model: 'model-b'")
    expect(firstPatch).not.toContain('model-b')
    expect(secondPatch).not.toContain('model-a')
    expect(firstStart?.extraOverlays).toEqual([join(firstDir, 'provider.patch.yml')])
    expect(secondStart?.extraOverlays).toEqual([join(secondDir, 'provider.patch.yml')])

    await first.stop()
    await second.stop()
  })

  it('leaves the profile, harness home and storage root where they were', async () => {
    const root = extensionRoot()
    const storage = join(root, 'storage')
    const extensionPath = join(root, 'extension')
    scenario.settings = companySettings('model-a')
    const host = new DshHost(context(root) as never, () => {})

    await host.start()
    await host.createBridge(webview)

    const start = scenario.starts[0]
    expect(host.storageDir).toBe(storage)
    expect(start?.storageDir).toBe(storage)
    expect(start?.overlayPath).toBe(join(extensionPath, 'profile', 'vscode.patch.yml'))
    expect(start?.launchDir.startsWith(join(storage, 'launch'))).toBe(true)
    expect((await host.diagnostics()).home).toBe(join(storage, 'home'))
    // Launch files no longer land directly in the shared storage root.
    expect(readdirSync(storage)).toEqual(['launch'])
    expect(existsSync(join(storage, 'provider.patch.yml'))).toBe(false)

    await host.stop()
  })

  it('removes only the directory of the activation that stops', async () => {
    const root = extensionRoot()
    const storage = join(root, 'storage')
    scenario.settings = companySettings('shared')
    const first = new DshHost(context(root) as never, () => {})
    const second = new DshHost(context(root) as never, () => {})
    await first.start()
    const firstBridge = await first.createBridge(webview)
    await second.start()
    const secondBridge = await second.createBridge(webview)
    const firstDir = scenario.starts[0]?.launchDir ?? ''
    const secondDir = scenario.starts[1]?.launchDir ?? ''

    await firstBridge.dispose()
    // The host owns the directory: a stopped view bridge alone does not remove it.
    expect(existsSync(firstDir)).toBe(true)
    await first.stop()

    expect(existsSync(firstDir)).toBe(false)
    expect(scenario.disposals.find(entry => entry.launchDir === firstDir)?.existedAtDispose).toBe(true)
    expect(existsSync(secondDir)).toBe(true)
    expect(existsSync(join(secondDir, 'provider.patch.yml'))).toBe(true)
    expect(second.snapshot().state).toBe('ready')

    await second.stop()
    expect(existsSync(secondDir)).toBe(false)
    // The shared parent stays for other windows.
    expect(existsSync(join(storage, 'launch'))).toBe(true)
  })

  it('cleans up the launch directory when the companion fails to boot', async () => {
    const root = extensionRoot()
    const storage = join(root, 'storage')
    scenario.settings = companySettings('model-a')
    scenario.failNext = true
    const host = new DshHost(context(root) as never, () => {})

    await host.start()
    await expect(host.createBridge(webview)).rejects.toThrow('exited during startup')

    const attempted = scenario.starts[0]?.launchDir ?? ''
    expect(attempted).not.toBe('')
    expect(existsSync(attempted)).toBe(false)
    expect(readdirSync(join(storage, 'launch'))).toEqual([])
    expect(host.snapshot().state).toBe('failed')

    await host.stop()
    expect(host.snapshot().state).toBe('stopped')
  })
})
