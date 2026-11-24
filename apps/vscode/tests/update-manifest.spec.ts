/**
 * Feed validation: every required field of `dsh-vscode-update/v1` is checked before anything downloads, and an
 * address is accepted only as HTTPS or as a plain-HTTP loopback test server.
 */
import { describe, expect, it } from 'vitest'
import { parseUpdateManifest, UPDATE_MANIFEST_SCHEMA } from '../src/host/update/manifest.ts'

/** @returns one feed that passes validation, as a mutable record. */
function validFeed(): Record<string, unknown> {
  return {
    schemaVersion: UPDATE_MANIFEST_SCHEMA,
    extensionId: 'deepseek-ai.dsh-vscode',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
    targetPlatform: 'win32-x64',
    url: 'https://updates.lan/dsh/dsh-vscode-0.2.0.vsix',
    sha256: 'a'.repeat(64),
    size: 1024,
    publishedAt: '2026-11-19T12:00:00.000Z',
  }
}

/** @param feed - feed record. @returns the parsed result of its JSON form. */
function parse(feed: Record<string, unknown>) {
  return parseUpdateManifest(JSON.stringify(feed))
}

describe('parseUpdateManifest', () => {
  it('accepts a feed and normalizes the version', () => {
    const result = parse({ ...validFeed(), version: 'v0.2.0', releaseNotes: 'Faster startup' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest).toMatchObject({
      schemaVersion: UPDATE_MANIFEST_SCHEMA,
      extensionId: 'deepseek-ai.dsh-vscode',
      version: '0.2.0',
      engines: { vscode: '^1.96.0' },
      targetPlatform: 'win32-x64',
      size: 1024,
      releaseNotes: 'Faster startup',
    })
  })

  it('leaves release notes absent when the feed omits them', () => {
    const result = parse(validFeed())
    expect(result.ok && result.manifest.releaseNotes).toBeUndefined()
  })

  it('ignores unknown members a later schema may add', () => {
    expect(parse({ ...validFeed(), signature: 'not read yet' }).ok).toBe(true)
  })

  it('rejects a document that is not one JSON object', () => {
    expect(parseUpdateManifest('not json')).toMatchObject({ ok: false, problem: { code: 'not-json' } })
    expect(parseUpdateManifest('[]')).toMatchObject({ ok: false, problem: { code: 'not-object' } })
    expect(parseUpdateManifest('null')).toMatchObject({ ok: false, problem: { code: 'not-object' } })
  })

  it('rejects another schema version', () => {
    const result = parse({ ...validFeed(), schemaVersion: 'dsh-vscode-update/v2' })
    expect(result).toMatchObject({ ok: false, problem: { code: 'schema-version', field: 'schemaVersion' } })
  })

  it('rejects an extension id that is not publisher.name', () => {
    for (const extensionId of ['dsh-vscode', 'DeepSeek-AI.dsh-vscode', 'deepseek-ai.', 'a.b.c', 42]) {
      expect(parse({ ...validFeed(), extensionId })).toMatchObject({
        ok: false,
        problem: { code: 'extension-id', field: 'extensionId' },
      })
    }
  })

  it('rejects a version that is not semver', () => {
    for (const version of ['0.2', 'latest', '', 2]) {
      expect(parse({ ...validFeed(), version })).toMatchObject({ ok: false, problem: { code: 'version' } })
    }
  })

  it('rejects a missing or invalid VS Code engine range', () => {
    expect(parse({ ...validFeed(), engines: {} })).toMatchObject({
      ok: false,
      problem: { code: 'engines', field: 'engines.vscode' },
    })
    expect(parse({ ...validFeed(), engines: undefined })).toMatchObject({ ok: false, problem: { code: 'engines' } })
    expect(parse({ ...validFeed(), engines: { vscode: 'newest' } })).toMatchObject({
      ok: false,
      problem: { code: 'engines' },
    })
  })

  it('rejects a platform that is neither universal nor platform-arch', () => {
    for (const targetPlatform of ['win32', 'win32-x64-musl', 'Universal', '', 7]) {
      expect(parse({ ...validFeed(), targetPlatform })).toMatchObject({
        ok: false,
        problem: { code: 'target-platform', field: 'targetPlatform' },
      })
    }
    expect(parse({ ...validFeed(), targetPlatform: 'universal' }).ok).toBe(true)
    expect(parse({ ...validFeed(), targetPlatform: 'darwin-arm64' }).ok).toBe(true)
  })

  it('accepts plain HTTP only for a loopback server', () => {
    expect(parse({ ...validFeed(), url: 'http://127.0.0.1:8080/dsh.vsix' }).ok).toBe(true)
    expect(parse({ ...validFeed(), url: 'http://localhost:8080/dsh.vsix' }).ok).toBe(true)
    expect(parse({ ...validFeed(), url: 'http://updates.lan/dsh.vsix' })).toMatchObject({
      ok: false,
      problem: { code: 'url', field: 'url' },
    })
    expect(parse({ ...validFeed(), url: 'ftp://updates.lan/dsh.vsix' })).toMatchObject({ ok: false, problem: { code: 'url' } })
    expect(parse({ ...validFeed(), url: 'not a url' })).toMatchObject({ ok: false, problem: { code: 'url' } })
    expect(parse({ ...validFeed(), url: 'https://user:secret@updates.lan/dsh.vsix' })).toMatchObject({
      ok: false,
      problem: { code: 'url' },
    })
  })

  it('rejects a digest that is not 64 lowercase hexadecimal characters', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 123]) {
      expect(parse({ ...validFeed(), sha256 })).toMatchObject({
        ok: false,
        problem: { code: 'sha256', field: 'sha256' },
      })
    }
  })

  it('rejects a size that is not a positive integer', () => {
    for (const size of [0, -1, 1.5, '1024', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parse({ ...validFeed(), size })).toMatchObject({ ok: false, problem: { code: 'size', field: 'size' } })
    }
  })

  it('rejects a publication time that is not an ISO date-time', () => {
    for (const publishedAt of ['2026-11-19', '19/11/2026', 'yesterday', 0]) {
      expect(parse({ ...validFeed(), publishedAt })).toMatchObject({
        ok: false,
        problem: { code: 'published-at', field: 'publishedAt' },
      })
    }
    expect(parse({ ...validFeed(), publishedAt: '2026-11-19T20:00:00+08:00' }).ok).toBe(true)
  })

  it('rejects release notes that are not bounded text', () => {
    expect(parse({ ...validFeed(), releaseNotes: 7 })).toMatchObject({
      ok: false,
      problem: { code: 'release-notes', field: 'releaseNotes' },
    })
    expect(parse({ ...validFeed(), releaseNotes: 'x'.repeat(4001) })).toMatchObject({
      ok: false,
      problem: { code: 'release-notes' },
    })
  })
})
