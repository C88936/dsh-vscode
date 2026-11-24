/**
 * Deployment model configuration for the status bar and the pre-prompt notice:
 * the launch mapping, the text shown per window, and the host query frames.
 */
import { describe, expect, it } from 'vitest'
import { launchModelConfig } from '../src/host/settings.ts'
import { modelStatusText } from '../src/shared/model-status.ts'
import { isHostConfigAnswer, isHostConfigRequest } from '../src/shared/host-protocol.ts'

/** A company provider settings double. */
function company(model: string): Parameters<typeof launchModelConfig>[0] {
  return {
    mode: 'openai-compatible', route: 'company', baseUrl: 'https://llm.example/v1', model, apiKeyEnv: 'DSH_LLM_API_KEY',
  }
}

describe('launchModelConfig', () => {
  it('reports a company route with a chosen model as configured', () => {
    expect(launchModelConfig(company('qwen-max'))).toEqual({ provider: 'company', model: 'qwen-max', configured: true })
  })

  it('reports a company route without a model as not configured', () => {
    expect(launchModelConfig(company('   '))).toEqual({ provider: 'company', model: '   ', configured: false })
  })

  it('reports the official route as configured without naming a model', () => {
    expect(launchModelConfig({ ...company(''), mode: 'deepseek' })).toEqual({ provider: 'deepseek-official', model: '', configured: true })
  })
})

describe('modelStatusText', () => {
  it('names the effective route and model', () => {
    expect(modelStatusText({ provider: 'company', model: 'qwen-max', configured: true }, false)).toBe('DSH: company/qwen-max')
    expect(modelStatusText({ provider: 'deepseek-official', model: '', configured: true }, false)).toBe('DSH: deepseek-official')
  })

  it('says no model is configured, and marks a window that saves different settings', () => {
    expect(modelStatusText({ provider: 'company', model: '', configured: false }, false)).toBe('DSH: no model configured')
    expect(modelStatusText({ provider: 'company', model: '', configured: false }, true)).toBe('DSH: no model configured (this window differs)')
    expect(modelStatusText({ provider: 'company', model: 'm', configured: true }, true)).toBe('DSH: company/m (this window differs)')
  })
})

describe('host config frames', () => {
  it('accepts one query and one complete answer', () => {
    expect(isHostConfigRequest({ type: 'host-config', id: 2 })).toBe(true)
    expect(isHostConfigRequest({ type: 'host-config' })).toBe(false)
    expect(isHostConfigAnswer({ type: 'host-config-result', id: 2, config: { provider: 'company', model: 'm', configured: true } })).toBe(true)
    expect(isHostConfigAnswer({ type: 'host-config-result', id: 2, config: { provider: 'company', model: 'm' } })).toBe(false)
    expect(isHostConfigAnswer({ type: 'host-config-result', id: 2 })).toBe(false)
  })
})

