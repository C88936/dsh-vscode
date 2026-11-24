/**
 * Credential and launch-environment behavior of the extension.
 */
import { describe, expect, it } from 'vitest'
import { companyKeySlot, credentialEnv, LLM_KEY_SECRET } from '../src/host/env.ts'

describe('companyKeySlot', () => {
  it('uses different slots for distinct endpoints and leaves the unscoped key unused', () => {
    const oldEndpoint = companyKeySlot('http://old.lan/v1')
    expect(companyKeySlot(' http://old.lan/v1/ ')).toBe(oldEndpoint)
    expect(companyKeySlot('http://old.lan/v2')).not.toBe(oldEndpoint)
    expect(companyKeySlot('http://new.lan/v1')).not.toBe(oldEndpoint)
    expect(oldEndpoint).not.toBe(LLM_KEY_SECRET)
  })
})

describe('credentialEnv', () => {
  it('maps a stored key and base URL to launch variables', () => {
    expect(credentialEnv({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:8000/v1' })).toEqual({
      DEEPSEEK_API_KEY: 'sk-test',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:8000/v1',
    })
  })

  it('omits absent and empty values instead of exporting empty strings', () => {
    expect(credentialEnv({})).toEqual({})
    expect(credentialEnv({ apiKey: '', baseUrl: '' })).toEqual({})
  })

  it('leaves the private endpoint key to the provider settings, not the public API variable', () => {
    // Clearing the private endpoint key's SecretStorage item says nothing about the public key variable.
    expect(credentialEnv({ llmApiKey: 'lan-key' })).toEqual({})
  })
})
