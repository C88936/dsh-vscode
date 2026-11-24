/**
 * Company first-run setup: the endpoint and optional key are collected without
 * a model id, the two deployment settings are written as global configuration,
 * the key is stored only in SecretStorage, and the guarded restart reports what
 * was saved separately from what is active.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const native = vi.hoisted(() => ({
  errors: [] as string[],
  infos: [] as string[],
  /** Configuration writes the command performed, in order. */
  updated: [] as { key: string; value: unknown; target: unknown }[],
  /** The failure a configuration update reports instead of saving. */
  updateFailure: '',
  failSetting: '',
  /** Layer values `inspect` reports, keyed by setting name. */
  layers: {} as Record<string, { workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined>,
}))

vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, params?: Record<string, string>) => Object.entries(params ?? {})
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), message),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    showErrorMessage: (message: string) => { native.errors.push(message); return Promise.resolve(undefined) },
    showInformationMessage: (message: string) => { native.infos.push(message); return Promise.resolve(undefined) },
    showWarningMessage: () => Promise.resolve(undefined),
    showInputBox: async () => undefined,
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      // The effective value is the last write; `inspect` reports overrides.
      get: (key: string) => [...native.updated].reverse().find(item => item.key === key)?.value,
      inspect: (key: string) => native.layers[key],
      update: async (key: string, value: unknown, target: unknown) => {
        if (native.updateFailure !== '' || key === native.failSetting) throw new Error(native.updateFailure || `${key} is locked`)
        native.updated.push({ key, value, target })
      },
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
  commands: { registerCommand: () => ({ dispose: () => {} }) },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
}))

// The command's own decision is what this suite covers; the host and view are doubles.
vi.mock('../src/host/host.ts', () => ({
  DshHost: class {},
  describe: (error: unknown) => error instanceof Error ? error.message : String(error),
}))
vi.mock('../src/view/chat-view.ts', () => ({ DshChatView: class {} }))

import { configureCompanyEndpoint, restartNoticeText, type CompanySetupRequest } from '../src/extension.ts'

/** A host double that can boot again, carrying the saved model so the message names it. */
function hostDouble(model: string) {
  return {
    restart: vi.fn(async () => {}),
    providerSettings: {
      mode: 'openai-compatible',
      route: 'company',
      baseUrl: 'http://llm.lan:8000/v1',
      model,
      apiKeyEnv: 'DSH_LLM_API_KEY',
    },
  }
}

function request(overrides: Partial<CompanySetupRequest> = {}): CompanySetupRequest {
  return {
    dsh: hostDouble('') as never,
    view: { refresh: async () => {}, freezeTransport: async () => {} } as never,
    guard: { blockers: () => [] },
    log: () => {},
    // The saved endpoint already equals the entered one, so only the endpoint-change
    // cases add the model-selection write.
    baseUrl: 'http://llm.lan:8000/v1',
    askBaseUrl: async () => 'http://llm.lan:8000/v1',
    askApiKey: async () => 'lan-key',
    writeKey: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('configureCompanyEndpoint', () => {
  it('writes both deployment settings as global configuration, stores the key, and restarts', async () => {
    native.updated.length = 0
    native.infos.length = 0
    const host = hostDouble('')
    const storeKey = vi.fn(async () => {})
    const refresh = vi.fn(async () => {})
    const lines: string[] = []
    await configureCompanyEndpoint(request({
      dsh: host as never,
      view: { refresh, freezeTransport: async () => {} } as never,
      log: line => { lines.push(line) },
      baseUrl: 'http://old.lan/v1',
      askBaseUrl: async () => ' http://llm.lan:8000/v1 ',
      askApiKey: async () => ' lan-key ',
      writeKey: storeKey,
    }))

    expect(native.updated).toEqual([
      { key: 'llmModel', value: '', target: 1 },
      { key: 'llmBaseUrl', value: 'http://llm.lan:8000/v1', target: 1 },
      { key: 'providerMode', value: 'openai-compatible', target: 1 },
    ])
    expect(storeKey).toHaveBeenCalledExactlyOnceWith('http://llm.lan:8000/v1', 'lan-key')
    expect(host.restart).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(native.infos).toEqual([
      'DSH restarted with the company endpoint. No model is selected for it yet; open Models, fetch the available models, and choose one.',
    ])
    // The key never reaches the diagnostic log.
    expect(lines.join('\n')).not.toContain('lan-key')
    expect(lines.join('\n')).toContain('key stored in SecretStorage')
  })

  it('writes a workspace override at the workspace layer so the runtime reads it', async () => {
    native.updated.length = 0
    native.layers = {
      llmBaseUrl: { workspaceValue: 'http://old.lan/v1' },
      providerMode: { workspaceValue: 'deepseek' },
    }
    onTestFinished(() => { native.layers = {} })
    await configureCompanyEndpoint(request({}))

    // A global write would be hidden by these overrides, so both values land in the workspace layer.
    expect(native.updated).toEqual([
      { key: 'llmBaseUrl', value: 'http://llm.lan:8000/v1', target: 2 },
      { key: 'providerMode', value: 'openai-compatible', target: 2 },
    ])
  })

  it('refuses a workspace-folder override instead of saving a value the runtime ignores', async () => {
    native.updated.length = 0
    native.errors.length = 0
    native.layers = { llmBaseUrl: { workspaceFolderValue: 'http://folder.lan/v1' } }
    onTestFinished(() => { native.layers = {} })
    const host = hostDouble('')
    const storeKey = vi.fn(async () => {})
    await configureCompanyEndpoint(request({ dsh: host as never, writeKey: storeKey }))

    expect(native.updated).toEqual([])
    expect(storeKey).not.toHaveBeenCalled()
    expect(host.restart).not.toHaveBeenCalled()
    expect(native.errors[0]).toContain("workspace folder's settings")
  })

  it('names the saved model when the endpoint did not change', async () => {
    native.updated.length = 0
    native.infos.length = 0
    const askBaseUrl = vi.fn(async () => 'http://llm.lan:8000/v1')
    await configureCompanyEndpoint(request({
      dsh: hostDouble('company-model') as never,
      baseUrl: ' http://llm.lan:8000/v1 ',
      askBaseUrl,
    }))

    expect(askBaseUrl).toHaveBeenCalledWith(' http://llm.lan:8000/v1 ')
    expect(native.infos).toEqual(['DSH restarted with the company endpoint and company-model.'])
    // The unchanged endpoint keeps its model selection.
    expect(native.updated.map(entry => entry.key)).toEqual(['llmBaseUrl', 'providerMode'])
  })

  it('clears the previous model selection when the endpoint changes', async () => {
    native.updated.length = 0
    native.infos.length = 0
    const host = hostDouble('company-model')
    await configureCompanyEndpoint(request({
      dsh: host as never,
      baseUrl: 'http://old.lan/v1',
      askBaseUrl: async () => 'http://new.lan/v1',
    }))

    // A model id belongs to the endpoint that listed it; the next launch boots on
    // the unconfigured placeholder until discovery names one the new endpoint serves.
    expect(native.updated).toContainEqual({ key: 'llmModel', value: '', target: 1 })
    expect(native.infos).toEqual([
      'DSH restarted with the company endpoint. No model is selected for it yet; open Models, fetch the available models, and choose one.',
    ])
  })

  it('refuses an unusable endpoint before asking for a key', async () => {
    native.updated.length = 0
    native.errors.length = 0
    const askApiKey = vi.fn(async () => 'lan-key')
    const storeKey = vi.fn(async () => {})
    await configureCompanyEndpoint(request({
      askBaseUrl: async () => 'ftp://llm.lan/v1',
      askApiKey,
      writeKey: storeKey,
    }))

    expect(native.updated).toEqual([])
    expect(askApiKey).not.toHaveBeenCalled()
    expect(storeKey).not.toHaveBeenCalled()
    expect(native.errors).toHaveLength(1)
    expect(native.errors[0]).toContain('http or https')
  })

  it('keeps the stored key when the key prompt is left empty', async () => {
    native.updated.length = 0
    const host = hostDouble('')
    const storeKey = vi.fn(async () => {})
    await configureCompanyEndpoint(request({
      dsh: host as never,
      askApiKey: async () => '   ',
      writeKey: storeKey,
    }))

    expect(native.updated).toHaveLength(2)
    expect(storeKey).not.toHaveBeenCalled()
    expect(host.restart).toHaveBeenCalledOnce()
  })

  it('writes nothing when either prompt is cancelled', async () => {
    native.updated.length = 0
    const storeKey = vi.fn(async () => {})
    await configureCompanyEndpoint(request({ askBaseUrl: async () => undefined, writeKey: storeKey }))
    await configureCompanyEndpoint(request({ askApiKey: async () => undefined, writeKey: storeKey }))
    expect(native.updated).toEqual([])
    expect(storeKey).not.toHaveBeenCalled()
  })

  it('reports a settings write failure without restarting', async () => {
    native.updated.length = 0
    native.errors.length = 0
    native.updateFailure = 'settings are locked'
    onTestFinished(() => { native.updateFailure = '' })
    const host = hostDouble('')
    const storeKey = vi.fn(async () => {})
    await configureCompanyEndpoint(request({ dsh: host as never, writeKey: storeKey }))

    expect(host.restart).not.toHaveBeenCalled()
    expect(native.errors[0]).toContain('could not complete the company endpoint setup')
    expect(native.errors[0]).toContain('settings are locked')
  })

  it('keeps the saved endpoint and running Host when key storage fails', async () => {
    native.updated.length = 0
    native.errors.length = 0
    const host = hostDouble('')
    const storeKey = vi.fn(async () => { throw new Error('secret storage unavailable') })
    await configureCompanyEndpoint(request({
      dsh: host as never,
      askBaseUrl: async () => 'http://new.lan/v1',
      writeKey: storeKey,
    }))

    expect(native.updated).toEqual([])
    expect(host.restart).not.toHaveBeenCalled()
    expect(native.errors[0]).toContain('could not update the company endpoint key in VS Code SecretStorage')
  })

  it('clears only the destination credential when changing endpoints with a blank key', async () => {
    const writeKey = vi.fn(async () => {})
    const host = hostDouble('')
    await configureCompanyEndpoint(request({
      askBaseUrl: async () => 'http://new.lan/v1',
      askApiKey: async () => ' ',
      dsh: host as never,
      writeKey,
    }))

    expect(writeKey).toHaveBeenCalledExactlyOnceWith('http://new.lan/v1', '')
    expect(host.restart).toHaveBeenCalledOnce()
  })

  it('keeps the saved endpoint and running Host when the old model cannot be cleared', async () => {
    native.updated.length = 0
    native.errors.length = 0
    native.failSetting = 'llmModel'
    onTestFinished(() => { native.failSetting = '' })
    const host = hostDouble('previous-model')
    await configureCompanyEndpoint(request({ dsh: host as never, askBaseUrl: async () => 'http://new.lan/v1' }))

    expect(native.updated).toEqual([])
    expect(host.restart).not.toHaveBeenCalled()
    expect(native.errors[0]).toContain('llmModel is locked')
  })

  it('reports the settings as saved when the guarded restart fails', async () => {
    native.updated.length = 0
    native.errors.length = 0
    const host = { ...hostDouble(''), restart: async () => { throw new Error('companion exited during startup') } }
    await expect(configureCompanyEndpoint(request({ dsh: host as never })))
      .rejects.toThrow('companion exited during startup')
    expect(native.updated).toHaveLength(2)
    expect(native.errors[0]).toContain('the company endpoint settings were saved')
    expect(native.errors[0]).toContain('did not start')
    expect(native.errors[0]).toContain('Run DSH: Restart Host')
  })

  it('reports a shared restart that came back with another window’s configuration', async () => {
    native.updated.length = 0
    native.errors.length = 0
    native.infos.length = 0
    const host = { ...hostDouble(''), configMismatch: true }
    await expect(configureCompanyEndpoint(request({ dsh: host as never })))
      .rejects.toThrow('different settings or a different extension version')

    expect(native.infos).toEqual([])
    expect(native.errors[0]).toContain('the company endpoint settings were saved')
  })
})

describe('restartNoticeText', () => {
  it('prompts the existing restart after a saved model, naming the changed setting', () => {
    const notice = restartNoticeText(['dsh.llmModel'])
    expect(notice).toContain('dsh.llmModel')
    expect(notice).toContain('Restart DSH')
    expect(notice).toContain('after running work finishes')
  })
})
