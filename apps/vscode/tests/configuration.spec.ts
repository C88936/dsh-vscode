/**
 * Writing a launch setting where it takes effect: a global write only reaches
 * the runtime when no workspace layer overrides it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  /** Layer values `inspect` reports, keyed by setting name. */
  layers: {} as Record<string, { workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined>,
  /** Values the fake configuration reads back. */
  values: {} as Record<string, unknown>,
  /** Writes the helper performed, in order. */
  updated: [] as { key: string; value: unknown; target: unknown }[],
  /** The failure an update reports instead of saving. */
  updateFailure: '',
  /** A value `get` reports after a write, to fake another layer winning. */
  readback: undefined as unknown,
  /** Whether `readback` overrides the written value. */
  staleReadback: false,
}))

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => {
      const snapshot = { ...native.values }
      return {
      inspect: (key: string) => native.layers[key],
      get: (key: string) => native.staleReadback ? native.readback : snapshot[key],
      update: async (key: string, value: unknown, target: unknown) => {
        if (native.updateFailure !== '') throw new Error(native.updateFailure)
        native.updated.push({ key, value, target })
        native.values[key] = value
      },
      }
    },
  },
}))

import { writeEffectiveSetting } from '../src/host/configuration.ts'

beforeEach(() => {
  native.layers = {}
  native.values = {}
  native.updated.length = 0
  native.updateFailure = ''
  native.readback = undefined
  native.staleReadback = false
})

describe('writeEffectiveSetting', () => {
  it('writes the global layer when no override exists', async () => {
    await expect(writeEffectiveSetting('llmModel', 'company-model'))
      .resolves.toEqual({ target: 1, overridden: [] })
    expect(native.updated).toEqual([{ key: 'llmModel', value: 'company-model', target: 1 }])
  })

  it('replaces a workspace override instead of a hidden global value', async () => {
    native.layers.llmModel = { workspaceValue: 'stale-model' }
    await expect(writeEffectiveSetting('llmModel', 'company-model'))
      .resolves.toEqual({ target: 2, overridden: ['workspace'] })
    expect(native.updated).toEqual([{ key: 'llmModel', value: 'company-model', target: 2 }])
  })

  it('refuses a workspace-folder override it cannot change', async () => {
    native.layers.llmModel = { workspaceFolderValue: 'folder-model' }
    await expect(writeEffectiveSetting('llmModel', 'company-model'))
      .rejects.toThrow(/workspace folder's settings/u)
    expect(native.updated).toEqual([])
  })

  it('reports a value another layer still overrides after the write', async () => {
    native.staleReadback = true
    native.readback = 'stale-model'
    await expect(writeEffectiveSetting('llmModel', 'company-model'))
      .rejects.toThrow(/still reads "stale-model"/u)
  })

  it('propagates a configuration update failure', async () => {
    native.updateFailure = 'settings are locked'
    await expect(writeEffectiveSetting('llmModel', 'company-model')).rejects.toThrow('settings are locked')
  })
})
