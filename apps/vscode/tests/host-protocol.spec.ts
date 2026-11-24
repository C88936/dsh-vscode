/**
 * Hello validation: identity labels are bounded, while the configuration
 * fingerprint accepts a long settings digest without rejecting the connection.
 */
import { describe, expect, it } from 'vitest'
import { isHostHelloOk, parseHostHello } from '../src/shared/host-protocol.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

/**
 * @param configFingerprint - fingerprint carried by the hello.
 * @returns one hello frame.
 */
function hello(configFingerprint: string): unknown {
  return {
    type: 'hello',
    protocol: 1,
    token: 'a'.repeat(64),
    clientId: 'window-a',
    extensionVersion: '0.0.0-test',
    configFingerprint,
    limits: DEFAULT_BRIDGE_LIMITS,
  }
}

describe('host hello validation', () => {
  it('accepts a configuration digest up to the fingerprint bound', () => {
    expect(parseHostHello(hello('f'.repeat(64)))).toBeDefined()
    expect(parseHostHello(hello('f'.repeat(512)))).toBeDefined()
  })

  it('refuses a fingerprint beyond the bound instead of dropping the hello silently', () => {
    expect(parseHostHello(hello('f'.repeat(513)))).toBeUndefined()
  })

  it('keeps identity labels at their own bound', () => {
    const frame = hello('config-1') as Record<string, unknown>
    frame.clientId = 'c'.repeat(201)
    expect(parseHostHello(frame)).toBeUndefined()
  })

  it('accepts an admission answer with a long fingerprint', () => {
    expect(isHostHelloOk({
      type: 'hello-ok',
      protocol: 1,
      instanceId: 'instance-1',
      connectionId: 'connection-1',
      dshVersion: '0.2.2-alpha.2',
      configFingerprint: 'f'.repeat(512),
    })).toBe(true)
  })
})
