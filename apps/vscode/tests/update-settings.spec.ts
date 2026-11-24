/**
 * The update feed is deployment configuration: VS Code must not let a workspace
 * redirect the trusted release source, so both update settings are application
 * scoped, and the two commands the flow needs are contributed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsUpdateShare } from '../src/host/update/share.ts'

/** The extension manifest the packaged VSIX copies. */
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    configuration: { properties: Record<string, { scope?: string; default?: unknown }> }
    commands: { command: string }[]
  }
}

describe('update settings', () => {
  it('ships a Windows update share and hourly checks in the company manifest', () => {
    const settings = manifest.contributes.configuration.properties
    const directory = settings['dsh.update.feedUrl']?.default
    expect(typeof directory === 'string' ? windowsUpdateShare(directory) : undefined).toBe(directory)
    expect(directory).toEqual(expect.stringMatching(/\\DeepseekHarness_VSCode$/u))
    expect(settings['dsh.update.checkIntervalMinutes']?.default).toBe(60)
  })

  it('scopes the feed and its interval to application settings', () => {
    const settings = manifest.contributes.configuration.properties
    for (const name of ['dsh.update.feedUrl', 'dsh.update.checkIntervalMinutes']) {
      expect(settings[name], name).toBeDefined()
      expect(settings[name]?.scope, name).toBe('application')
    }
  })

  it('contributes both update commands', () => {
    const commands = manifest.contributes.commands.map(entry => entry.command)
    expect(commands).toContain('dsh.checkForUpdates')
    expect(commands).toContain('dsh.installUpdate')
  })
})
