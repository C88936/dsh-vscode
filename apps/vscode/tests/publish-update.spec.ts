/**
 * The publisher tool writes a feed only for the bytes its release record names: a digest that disagrees with the VSIX
 * fails the command, and an existing feed is checked field by field against the VSIX on disk.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/publish-update.mjs', import.meta.url))
const baseUrl = 'http://127.0.0.1:8080/dsh'
const vsixBytes = Buffer.from('a packaged VSIX body')
const directories: string[] = []

/** One release fixture: a VSIX, its release record, and the extension manifest. */
interface Fixture {
  /** Directory holding the fixture. */
  readonly directory: string
  /** VSIX path. */
  readonly vsix: string
  /** Release record path. */
  readonly release: string
  /** Extension manifest path. */
  readonly manifest: string
  /** Feed path. */
  readonly out: string
}

/** @returns a fixture directory that the suite removes. */
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-vscode-publish-'))
  directories.push(directory)
  return directory
}

/**
 * @param digest - digest the release record declares.
 * @returns a complete release fixture.
 */
function fixture(digest = createHash('sha256').update(vsixBytes).digest('hex')): Fixture {
  const directory = workspace()
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-vscode',
    publisher: 'deepseek-ai',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
  }, null, 2)}\n`)
  writeFileSync(join(directory, 'release.json'), `${JSON.stringify({
    generatedAt: '2026-11-19T12:00:00.000Z',
    extension: {
      version: '0.2.0',
      file: 'dsh-vscode-0.2.0.vsix',
      sha256: digest,
      runtimeRange: '>=0.2.2-alpha.2 <0.3.0',
    },
    runtime: { platform: 'win32', arch: 'x64', version: '0.2.2-alpha.2' },
  }, null, 2)}\n`)
  const vsix = join(directory, 'dsh-vscode-0.2.0.vsix')
  writeFileSync(vsix, vsixBytes)
  return {
    directory,
    vsix,
    release: join(directory, 'release.json'),
    manifest: join(directory, 'manifest.json'),
    out: join(directory, 'release-feed.json'),
  }
}

/**
 * @param paths - fixture paths. @param extra - further arguments.
 * @returns the script result.
 */
function publish(paths: Fixture, extra: string[] = []) {
  return spawnSync(process.execPath, [
    script,
    '--vsix', paths.vsix,
    '--release', paths.release,
    '--manifest', paths.manifest,
    '--out', paths.out,
    ...extra,
  ], { encoding: 'utf8' })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('publish-update', () => {
  it('writes a feed that names the measured digest, size, and download address', () => {
    const paths = fixture()

    const result = publish(paths, ['--base-url', baseUrl, '--notes', 'Faster startup'])

    expect(result.status).toBe(0)
    const feed = JSON.parse(readFileSync(paths.out, 'utf8')) as Record<string, unknown>
    expect(feed).toMatchObject({
      schemaVersion: 'dsh-vscode-update/v1',
      extensionId: 'deepseek-ai.dsh-vscode',
      version: '0.2.0',
      engines: { vscode: '^1.96.0' },
      targetPlatform: 'win32-x64',
      sha256: createHash('sha256').update(vsixBytes).digest('hex'),
      size: vsixBytes.byteLength,
      releaseNotes: 'Faster startup',
    })
    expect(feed.url).toBe('http://127.0.0.1:8080/dsh/dsh-vscode-0.2.0.vsix')
    expect(typeof feed.publishedAt).toBe('string')
  })

  it('fails loudly when the VSIX does not match the release record and writes no feed', () => {
    const paths = fixture('0'.repeat(64))

    const result = publish(paths, ['--base-url', baseUrl])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('describe different builds')
    expect(existsSync(paths.out)).toBe(false)
  })

  it('refuses a plain-HTTP address off loopback', () => {
    const paths = fixture()

    const result = publish(paths, ['--base-url', 'http://updates.lan/dsh'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('plain HTTP is allowed only for a loopback test server')
    expect(existsSync(paths.out)).toBe(false)
  })

  it('requires a base URL before it writes a download address', () => {
    const paths = fixture()

    const result = publish(paths)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--base-url or --windows-share is required')
  })

  it('verifies an existing feed against the VSIX', () => {
    const paths = fixture()
    publish(paths, ['--base-url', baseUrl])

    const verified = publish(paths, ['--verify'])

    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('matches 0.2.0')
  })

  it('rejects a feed whose digest no longer describes the VSIX', () => {
    const paths = fixture()
    publish(paths, ['--base-url', baseUrl])
    const feed = JSON.parse(readFileSync(paths.out, 'utf8')) as Record<string, unknown>
    writeFileSync(paths.out, `${JSON.stringify({ ...feed, sha256: 'f'.repeat(64) }, null, 2)}\n`)

    const verified = publish(paths, ['--verify'])

    expect(verified.status).toBe(1)
    expect(verified.stderr).toContain('does not match')
    expect(verified.stderr).toContain('the VSIX hashes to')
  })
})
