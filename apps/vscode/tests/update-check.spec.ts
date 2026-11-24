/**
 * Eligibility: a feed replaces the installed extension only when it names the same extension, publishes a newer
 * version, supports this VS Code, and targets this platform or is universal.
 */
import { describe, expect, it } from 'vitest'
import { currentTargetPlatform, evaluateUpdate } from '../src/host/update/check.ts'
import { parseUpdateManifest, type UpdateManifest } from '../src/host/update/manifest.ts'

/** @param overrides - fields the case changes. @returns one validated feed. */
function manifest(overrides: Record<string, unknown> = {}): UpdateManifest {
  const result = parseUpdateManifest(JSON.stringify({
    schemaVersion: 'dsh-vscode-update/v1',
    extensionId: 'deepseek-ai.dsh-vscode',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
    targetPlatform: 'win32-x64',
    url: 'https://updates.lan/dsh/dsh-vscode-0.2.0.vsix',
    sha256: 'a'.repeat(64),
    size: 1024,
    publishedAt: '2026-11-19T12:00:00.000Z',
    ...overrides,
  }))
  if (!result.ok) throw new Error(result.problem.detail)
  return result.manifest
}

/** @param overrides - fields the case changes. @returns one eligibility decision for a 1.96.0 window. */
function decide(overrides: Record<string, unknown> = {}) {
  return evaluateUpdate({
    manifest: manifest(overrides),
    extensionId: 'deepseek-ai.dsh-vscode',
    localVersion: '0.1.0',
    vscodeVersion: '1.96.0',
    targetPlatform: 'win32-x64',
  })
}

describe('evaluateUpdate', () => {
  it('accepts a newer version of the same extension', () => {
    const result = decide()
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.update.version).toBe('0.2.0')
    expect(result.update.localVersion).toBe('0.1.0')
  })

  it('rejects an older version', () => {
    expect(decide({ version: '0.0.9' })).toMatchObject({ eligible: false, code: 'version' })
    const result = decide({ version: '0.0.9' })
    expect(!result.eligible && result.reason).toContain('not newer')
  })

  it('rejects the installed version', () => {
    expect(evaluateUpdate({
      manifest: manifest({ version: '0.1.0' }),
      extensionId: 'deepseek-ai.dsh-vscode',
      localVersion: '0.1.0',
      vscodeVersion: '1.96.0',
      targetPlatform: 'win32-x64',
    })).toMatchObject({ eligible: false, code: 'version' })
  })

  it('orders prereleases by semver precedence', () => {
    const decision = (version: string, localVersion: string) => evaluateUpdate({
      manifest: manifest({ version }),
      extensionId: 'deepseek-ai.dsh-vscode',
      localVersion,
      vscodeVersion: '1.96.0',
      targetPlatform: 'win32-x64',
    })
    expect(decision('0.2.0-beta.2', '0.2.0-beta.1')).toMatchObject({ eligible: true })
    expect(decision('0.2.0-beta.1', '0.2.0-beta.2')).toMatchObject({ eligible: false, code: 'version' })
    expect(decision('0.2.0', '0.2.0-beta.2')).toMatchObject({ eligible: true })
    expect(decision('0.2.0-beta.2', '0.2.0')).toMatchObject({ eligible: false, code: 'version' })
  })

  it('rejects a feed whose VS Code engine range excludes this VS Code', () => {
    const result = decide({ engines: { vscode: '^1.100.0' } })
    expect(result).toMatchObject({ eligible: false, code: 'engine' })
    expect(!result.eligible && result.reason).toContain('^1.100.0')
  })

  it('accepts a feed whose engine range includes this VS Code', () => {
    expect(decide({ engines: { vscode: '>=1.90.0 <2.0.0' } })).toMatchObject({ eligible: true })
  })

  it('rejects a package built for another platform', () => {
    const result = evaluateUpdate({
      manifest: manifest({ targetPlatform: 'linux-x64' }),
      extensionId: 'deepseek-ai.dsh-vscode',
      localVersion: '0.1.0',
      vscodeVersion: '1.96.0',
      targetPlatform: 'win32-x64',
    })
    expect(result).toMatchObject({ eligible: false, code: 'platform' })
    expect(!result.eligible && result.reason).toContain('linux-x64')
  })

  it('accepts a universal package on any platform', () => {
    expect(decide({ targetPlatform: 'universal' })).toMatchObject({ eligible: true })
  })

  it('rejects a feed that names another extension', () => {
    const result = decide({ extensionId: 'deepseek-ai.other-extension' })
    expect(result).toMatchObject({ eligible: false, code: 'extension-id' })
    expect(!result.eligible && result.reason).toContain('deepseek-ai.other-extension')
  })

  it('reports an unreadable installed version instead of treating it as older', () => {
    expect(evaluateUpdate({
      manifest: manifest(),
      extensionId: 'deepseek-ai.dsh-vscode',
      localVersion: 'not-semver',
      vscodeVersion: '1.96.0',
      targetPlatform: 'win32-x64',
    })).toMatchObject({ eligible: false, code: 'version' })
  })

  it('reads this process for the current target platform', () => {
    expect(currentTargetPlatform()).toBe(`${process.platform}-${process.arch}`)
  })
})
