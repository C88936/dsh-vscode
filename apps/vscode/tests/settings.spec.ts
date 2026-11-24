/**
 * Company setup status, the first-run endpoint and model checks, the
 * selected-provider credential state, and the changed launch settings that
 * require a companion restart.
 */
import { describe, expect, it } from 'vitest'
import {
  changedProviderSettings,
  companyBaseUrlError,
  companySetupStatus,
  MAX_MODEL_ID_LENGTH,
  providerModelIdError,
  selectedProviderKey,
  UNCONFIGURED_MODEL_ID,
  type ProviderSettings,
} from '../src/host/settings.ts'

const settings: ProviderSettings = {
  mode: 'openai-compatible',
  route: 'company',
  baseUrl: 'http://llm.lan:8000/v1',
  model: 'company-model',
  apiKeyEnv: 'DSH_LLM_API_KEY',
}

describe('companySetupStatus', () => {
  it('reports a complete deployment setup', () => {
    expect(companySetupStatus(settings, { llmApiKey: 'lan-key' }))
      .toEqual({ missing: [], credential: 'stored', complete: true })
  })

  it('names every missing required field in setup order', () => {
    expect(companySetupStatus({ ...settings, baseUrl: '', model: ' ' }, {})).toEqual({
      missing: ['endpoint', 'model'],
      credential: 'not-stored',
      complete: false,
    })
  })

  it('reports an absent endpoint key without treating the route as incomplete', () => {
    // The endpoint may accept unauthenticated calls, and settings cannot tell
    // whether it requires a key; the route is complete once endpoint and model are known.
    expect(companySetupStatus(settings, {})).toEqual({ missing: [], credential: 'not-stored', complete: true })
    expect(companySetupStatus(settings, { llmApiKey: '' }))
      .toEqual({ missing: [], credential: 'not-stored', complete: true })
  })

  it('treats a whitespace-only model id as missing', () => {
    expect(companySetupStatus({ ...settings, model: ' ' }, { llmApiKey: 'lan-key' }))
      .toEqual({ missing: ['model'], credential: 'stored', complete: false })
  })
})

describe('selectedProviderKey', () => {
  it('reports the company key only while the company route is selected', () => {
    expect(selectedProviderKey(settings, { apiKey: 'deepseek-key', llmApiKey: 'lan-key' }))
      .toEqual({ envName: 'DSH_LLM_API_KEY', stored: true })
    expect(selectedProviderKey(settings, { apiKey: 'deepseek-key' }))
      .toEqual({ envName: 'DSH_LLM_API_KEY', stored: false })
  })

  it('reports the DeepSeek key only while the DeepSeek route is selected', () => {
    expect(selectedProviderKey({ ...settings, mode: 'deepseek' }, { llmApiKey: 'lan-key' }))
      .toEqual({ envName: 'DEEPSEEK_API_KEY', stored: false })
    expect(selectedProviderKey({ ...settings, mode: 'deepseek' }, { apiKey: 'deepseek-key' }))
      .toEqual({ envName: 'DEEPSEEK_API_KEY', stored: true })
  })

  it('treats an empty stored value as missing', () => {
    expect(selectedProviderKey(settings, { llmApiKey: '' })).toEqual({ envName: 'DSH_LLM_API_KEY', stored: false })
  })
})

describe('changedProviderSettings', () => {  it('reports no change for the same launch snapshot', () => {
    expect(changedProviderSettings(settings, { ...settings })).toEqual([])
  })

  it('names each changed launch setting', () => {
    expect(changedProviderSettings(settings, {
      ...settings,
      mode: 'deepseek',
      route: 'other',
      baseUrl: 'http://other.lan/v1',
      model: 'other-model',
      apiKeyEnv: 'OTHER_KEY',
      contextWindow: 32_768,
      maxTokens: 4_096,
    })).toEqual([
      'dsh.providerMode',
      'dsh.providerRoute',
      'dsh.llmBaseUrl',
      'dsh.llmModel',
      'dsh.llmApiKeyEnv',
      'dsh.llmContextWindow',
      'dsh.llmMaxTokens',
    ])
  })

  it('reports a limit that was added or removed', () => {
    const limited: ProviderSettings = { ...settings, contextWindow: 131_072 }
    expect(changedProviderSettings(settings, limited)).toEqual(['dsh.llmContextWindow'])
    expect(changedProviderSettings(limited, settings)).toEqual(['dsh.llmContextWindow'])
  })
})

describe('companyBaseUrlError', () => {
  it('accepts an HTTP(S) Chat Completions root', () => {
    expect(companyBaseUrlError('http://llm.lan:8000/v1')).toBeUndefined()
    expect(companyBaseUrlError('  https://llm.lan/v1  ')).toBeUndefined()
  })

  it('refuses an empty, non-URL, non-HTTP, or credential-bearing endpoint', () => {
    expect(companyBaseUrlError(' ')).toContain('empty')
    expect(companyBaseUrlError('llm.lan/v1')).toContain('not a URL')
    expect(companyBaseUrlError('ftp://llm.lan/v1')).toContain('http or https')
    expect(companyBaseUrlError('http://user:secret@llm.lan/v1')).toContain('must not embed credentials')
  })
})

describe('providerModelIdError', () => {
  it('accepts a listed model id', () => {
    expect(providerModelIdError('company-model')).toBeUndefined()
    expect(providerModelIdError('qwen-2.5-coder:32b')).toBeUndefined()
  })

  it('refuses an empty or whitespace-only id', () => {
    expect(providerModelIdError('')).toContain('empty')
    expect(providerModelIdError('   ')).toContain('empty')
  })

  it('refuses an over-long id, a control character, and the unconfigured placeholder', () => {
    expect(providerModelIdError('m'.repeat(MAX_MODEL_ID_LENGTH + 1))).toContain('longer than')
    expect(providerModelIdError('m'.repeat(MAX_MODEL_ID_LENGTH))).toBeUndefined()
    expect(providerModelIdError('line\nbreak')).toContain('control character')
    expect(providerModelIdError(` ${UNCONFIGURED_MODEL_ID} `)).toContain('unconfigured placeholder')
  })
})
