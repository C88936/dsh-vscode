/**
 * Private provider routing: the generated overlay adds the deployment route and
 * its model limits, names that route to the Models page, rejects unusable
 * settings, and leaves the model selection to the profile.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { providerPatch } from '../src/host/provider.ts'
import { PROVIDER_DEFAULTS, providerEnv, UNCONFIGURED_MODEL_ID, type ProviderSettings } from '../src/host/settings.ts'

/** A complete OpenAI-compatible configuration. */
const settings: ProviderSettings = {
  mode: 'openai-compatible',
  route: 'company',
  baseUrl: 'http://llm.lan:8000/v1',
  model: 'company-model',
  apiKeyEnv: 'DSH_LLM_API_KEY',
}

describe('providerPatch', () => {
  it('adds an openai-completions route for the model the endpoint serves', () => {
    const patch = providerPatch(settings)
    expect(patch).toContain('api: openai-completions')
    expect(patch).toContain("baseURL: 'http://llm.lan:8000/v1'")
    expect(patch).toContain("apiKeyEnv: 'DSH_LLM_API_KEY'")
    expect(patch).toContain("- id: 'company-model'")
  })

  it('pins the deployment model as the agent default', () => {
    const patch = providerPatch(settings)
    expect(patch).toContain('- id: agent-default-model')
    expect(patch).toContain("provider: 'company'")
    expect(patch).toContain("model: 'company-model'")
  })

  it('writes configured model limits into the model entry', () => {
    const patch = providerPatch({ ...settings, contextWindow: 131_072, maxTokens: 8_192 })
    expect(patch).toContain("          - id: 'company-model'\n            contextWindow: 131072\n            maxTokens: 8192\n")
  })

  it('keeps the adapter defaults by omitting unset model limits', () => {
    const patch = providerPatch(settings)
    expect(patch).not.toContain('contextWindow')
    expect(patch).not.toContain('maxTokens')
  })

  it('returns no overlay for the DeepSeek route', () => {
    expect(providerPatch({ ...settings, mode: 'deepseek' })).toBeUndefined()
  })

  it('pins a marked placeholder while the endpoint is set but no model is chosen yet', () => {
    // The first-run setup collects the endpoint before any model is known; the
    // overlay must still boot so the Models page can run discovery.
    const patch = providerPatch({ ...settings, model: '' })
    expect(patch).toContain('# Placeholder until dsh.llmModel names the model this endpoint serves.')
    expect(patch).toContain('# is not served by the endpoint and is not usable for inference.')
    expect(patch).toContain("          - id: 'dsh-unconfigured-model'")
    expect(patch).toContain("    model: 'dsh-unconfigured-model'")
    expect(patch).not.toContain("model: ''")
    expect(patch).not.toContain("- id: ''")
  })

  it('inserts the placeholder gate as a new row when the caller supplies one', () => {
    const gate = { module: 'file:///launch/model-gate.mjs', model: UNCONFIGURED_MODEL_ID }
    const patch = providerPatch({ ...settings, model: '' }, gate)
    // A bare row would only patch an existing entry with that id, so the gate needs an explicit insert list.
    expect(patch).toContain('- insert:')
    expect(patch).toContain('    - id: company-unconfigured-model-gate')
    expect(patch).toContain("      name: 'file:///launch/model-gate.mjs'")
    expect(patch).toContain(`        model: '${UNCONFIGURED_MODEL_ID}'`)
  })

  it('inserts no gate for a real model or when no gate module is supplied', () => {
    const gate = { module: 'file:///launch/model-gate.mjs', model: UNCONFIGURED_MODEL_ID }
    expect(providerPatch(settings, gate)).not.toContain('company-unconfigured-model-gate')
    expect(providerPatch({ ...settings, model: '' })).not.toContain('company-unconfigured-model-gate')
  })

  it('keeps the real-model path free of the placeholder', () => {
    const patch = providerPatch(settings)
    expect(patch).not.toContain('dsh-unconfigured-model')
    expect(patch).not.toContain('Placeholder until')
    expect(patch).toContain("          - id: 'company-model'")
    expect(patch).toContain("    model: 'company-model'")
  })

  it('reads the placeholder overlay as a valid route and agent default', () => {
    // The placeholder is not a served model, but it must be a valid patch: the
    // application boots on it so the Models page can run discovery.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vscode-provider-setup-'))
    try {
      const file = join(dir, 'provider.patch.yml')
      const patch = providerPatch({ ...settings, model: '' })
      if (patch === undefined) throw new Error('the OpenAI-compatible route must generate an overlay')
      writeFileSync(file, patch)
      const overlay = loadOverlayPatches('dsh', file)
      const entries = composeEntries([
        { insert: [{ id: 'llm-pi-ai', config: { providers: {} } }, { id: 'agent-default-model', config: {} }] },
        overlay,
      ])
      expect(entries.find(entry => entry.id === 'llm-pi-ai')?.config).toEqual({
        providers: {
          company: {
            api: 'openai-completions',
            baseURL: 'http://llm.lan:8000/v1',
            apiKeyEnv: 'DSH_LLM_API_KEY',
            models: [{ id: UNCONFIGURED_MODEL_ID }],
          },
        },
      })
      expect(entries.find(entry => entry.id === 'agent-default-model')?.config).toEqual({
        provider: 'company',
        model: UNCONFIGURED_MODEL_ID,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the configured route as the only deployment-owned one on the Models page', () => {
    const patch = providerPatch({ ...settings, route: 'corp-llm' })
    expect(patch).toContain('- id: ui-settings-models')
    expect(patch).toContain("deploymentOwnedRoute: 'corp-llm'")
    // The row patch replaces the shipped overlay's whole config, so the
    // carrier's credential-onboarding choice is restated with the route.
    expect(patch).toContain('credentialOnboarding: false')
  })

  it('keeps a profile edit to the deployment route from taking effect', () => {
    // The configuration editor persists only when the effective composed config
    // equals the attempted one; this overlay sits above the profile, so a
    // profile write to the deployment route's fields is refused.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vscode-provider-'))
    try {
      const file = join(dir, 'provider.patch.yml')
      const patch = providerPatch(settings)
      if (patch === undefined) throw new Error('the OpenAI-compatible route must generate an overlay')
      writeFileSync(file, patch)
      const overlay = loadOverlayPatches('dsh', file)
      const shipped = {
        insert: [
          { id: 'llm-pi-ai', config: { providers: {} } },
          { id: 'ui-settings-models', config: { credentialOnboarding: false } },
        ],
      }
      const profileEdit = [{
        id: 'llm-pi-ai',
        config: { providers: { company: { baseURL: 'http://profile.example/v1', models: [{ id: 'profile-model' }] } } },
      }]
      const entries = composeEntries([shipped, profileEdit, overlay])
      expect(entries.find(entry => entry.id === 'llm-pi-ai')?.config).toEqual({
        providers: {
          company: {
            api: 'openai-completions',
            baseURL: 'http://llm.lan:8000/v1',
            apiKeyEnv: 'DSH_LLM_API_KEY',
            models: [{ id: 'company-model' }],
          },
        },
      })
      expect(entries.find(entry => entry.id === 'ui-settings-models')?.config).toEqual({
        credentialOnboarding: false,
        deploymentOwnedRoute: 'company',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unusable route, URL, credential name, or limit', () => {
    expect(() => providerPatch({ ...settings, route: 'Company Route' })).toThrow(/lowercase hyphenated/u)
    expect(() => providerPatch({ ...settings, baseUrl: 'not a url' })).toThrow(/not a URL/u)
    expect(() => providerPatch({ ...settings, baseUrl: '' })).toThrow(/endpoint URL is empty/u)
    expect(() => providerPatch({ ...settings, baseUrl: 'ftp://llm.lan' })).toThrow(/http or https/u)
    expect(() => providerPatch({ ...settings, baseUrl: 'http://user:secret@llm.lan/v1' })).toThrow(/must not embed credentials/u)
    expect(() => providerPatch({ ...settings, apiKeyEnv: 'not a name' })).toThrow(/environment name/u)
    expect(() => providerPatch({ ...settings, contextWindow: 0 })).toThrow(/context window/u)
    expect(() => providerPatch({ ...settings, maxTokens: 1.5 })).toThrow(/output-token cap/u)
    expect(() => providerPatch({ ...settings, maxTokens: -1 })).toThrow(/positive integer/u)
  })
})

describe('providerEnv', () => {
  it('places the stored key under the configured environment name', () => {
    expect(providerEnv(settings, { llmApiKey: 'lan-key' })).toEqual({ DSH_LLM_API_KEY: 'lan-key' })
  })

  it('exports nothing without a stored key', () => {
    expect(providerEnv(settings, {})).toEqual({})
  })

  it('falls back to the documented defaults for an empty setting', () => {
    expect(PROVIDER_DEFAULTS.route).toBe('company')
    expect(PROVIDER_DEFAULTS.apiKeyEnv).toBe('DSH_LLM_API_KEY')
  })
})
