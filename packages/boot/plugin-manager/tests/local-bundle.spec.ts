/**
 * Prepared-local identity: a package directory or `.tgz` archive is read for
 * the manifest a replacement must name before anything installs.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalBundleEntries, readLocalBundleManifest, readPreparedBundle } from '../src/local-bundle.ts'
import { writePreparedArchive, writePreparedBundle, type PreparedBundleOptions } from './prepared-bundle.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-local-bundle-'))
  roots.push(directory)
  return directory
}

/**
 * @param entries - tar entry names, optional ustar prefixes, and bodies, in archive order.
 * @param options - `size` overrides one header's size field.
 * @returns gzip-compressed ustar bytes.
 */
function archive(
  entries: readonly { readonly name: string; readonly body: string; readonly prefix?: string }[],
  options: { size?: string } = {},
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body)
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    if (entry.prefix !== undefined) header.write(entry.prefix, 345, 155, 'utf8')
    header.write(options.size ?? `${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const MANIFEST = JSON.stringify({ name: 'dsh-local', version: '2.0.0', description: 'Local.', dsh: { bundle: {} } })

describe('readLocalBundleManifest', () => {
  it('reads the package.json a prepared directory carries', () => {
    const directory = join(root(), 'plugin')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), MANIFEST)
    const read = readLocalBundleManifest('path', directory)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.manifest).toMatchObject({ name: 'dsh-local', version: '2.0.0' })
  })

  it.each([
    ['no package.json', undefined, 'the package cannot be read'],
    ['unreadable JSON', '{"name":', 'is not readable JSON'],
    ['an array', '[]', 'is not a package manifest'],
  ] as const)('refuses a directory with %s', (_name, body, reason) => {
    const directory = join(root(), 'plugin')
    mkdirSync(directory, { recursive: true })
    if (body !== undefined) writeFileSync(join(directory, 'package.json'), body)
    const read = readLocalBundleManifest('path', directory)
    expect(read).toMatchObject({ ok: false, problem: 'not-a-package' })
    if (!read.ok) expect(read.reason).toContain(reason)
  })

  it('refuses a path that is not a package directory', () => {
    const file = join(root(), 'file.json')
    writeFileSync(file, '{}')
    expect(readLocalBundleManifest('path', file)).toEqual({
      ok: false, problem: 'not-a-package', reason: 'the path is not a package directory',
    })
  })

  it('reads the package/package.json an archive carries', () => {
    const file = join(root(), 'plugin.tgz')
    writeFileSync(file, archive([
      { name: 'package/readme.md', body: 'readme' },
      { name: 'package/package.json', body: MANIFEST },
    ]))
    const read = readLocalBundleManifest('tarball', file)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.manifest).toMatchObject({ name: 'dsh-local', version: '2.0.0' })
  })

  it('accepts a root-level manifest and a prefix-split entry name', () => {
    const atRoot = join(root(), 'root.tgz')
    writeFileSync(atRoot, archive([{ name: 'package.json', body: MANIFEST }]))
    expect(readLocalBundleManifest('tarball', atRoot).ok).toBe(true)
    // ustar splits a long entry path into a prefix and a name; the reader joins them.
    const prefixed = join(root(), 'prefixed.tgz')
    writeFileSync(prefixed, archive([{ name: 'package.json', body: MANIFEST, prefix: 'package' }]))
    expect(readLocalBundleManifest('tarball', prefixed).ok).toBe(true)
  })

  it.each([
    ['no manifest entry', archive([{ name: 'package/readme.md', body: 'readme' }]), 'the tarball carries no package/package.json'],
    ['a malformed size field', archive([{ name: 'package/package.json', body: MANIFEST }], { size: 'zzzzzzzzzzz\0' }), 'the tarball carries no package/package.json'],
    ['a truncated entry', archive([{ name: 'package/package.json', body: MANIFEST }], { size: '00001000000\0' }), 'the tarball carries no package/package.json'],
  ] as const)('refuses an archive with %s', (_name, bytes, reason) => {
    const file = join(root(), 'plugin.tgz')
    writeFileSync(file, bytes)
    const read = readLocalBundleManifest('tarball', file)
    expect(read).toMatchObject({ ok: false, problem: 'not-a-package' })
    if (!read.ok) expect(read.reason).toBe(reason)
  })

  it('reports an archive it cannot decompress', () => {
    const file = join(root(), 'plugin.tgz')
    writeFileSync(file, 'not a gzip archive')
    expect(readLocalBundleManifest('tarball', file)).toMatchObject({
      ok: false, problem: 'not-a-package', reason: expect.stringContaining('the package cannot be read') as string,
    })
  })
})

/** One prepared bundle whose record, lockfile, and installed copy agree. */
const CLOSURE: PreparedBundleOptions = {
  name: 'dsh-local',
  version: '2.0.0',
  dependencies: { 'left-pad': '^1.3.0' },
  packages: [{ name: 'left-pad', version: '1.3.0', integrity: 'sha512-left-pad' }],
}

/**
 * @param directory - a prepared bundle directory.
 * @returns its verified closure.
 */
function prepared(directory: string): Extract<ReturnType<typeof readPreparedBundle>, { ok: true }> {
  const read = readPreparedBundle('path', directory)
  if (!read.ok) throw new Error(read.reason)
  return read
}

/**
 * @param problems - a closure's problems.
 * @returns their reasons, joined for a substring assertion.
 */
function reasons(problems: readonly { readonly reason: string }[]): string {
  return problems.map(problem => problem.reason).join('; ')
}

describe('readLocalBundleEntries', () => {
  const PATCH = '- insert:\n    - id: inbound\n      name: "@scope/pkg"\n'

  it('reads the rows a prepared directory patch declares before it is installed', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, { ...CLOSURE, extraFiles: { 'cordis.patch.yml': PATCH } })
    expect(readLocalBundleEntries('path', directory)).toEqual({
      ok: true, entries: [{ id: 'inbound', name: '@scope/pkg' }],
    })
  })

  it('reads the rows a prepared archive patch declares', () => {
    const archivePath = join(root(), 'prepared.tgz')
    writePreparedArchive(archivePath, { ...CLOSURE, extraFiles: { 'cordis.patch.yml': PATCH } })
    expect(readLocalBundleEntries('tarball', archivePath)).toEqual({
      ok: true, entries: [{ id: 'inbound', name: '@scope/pkg' }],
    })
  })

  it('reports a declared patch the package does not carry', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, { ...CLOSURE, manifestExtra: { dsh: { bundle: { patch: './absent.yml' } } } })
    const read = readLocalBundleEntries('path', directory)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain('does not carry it')
  })

  it('reports an unusable patch declaration and a package that inserts nothing', () => {
    const malformed = join(root(), 'malformed')
    writePreparedBundle(malformed, { ...CLOSURE, manifestExtra: { dsh: { bundle: { patch: 42 } } } })
    const read = readLocalBundleEntries('path', malformed)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain('must be a file path')
    const plain = join(root(), 'plain-bundle')
    writePreparedBundle(plain, { ...CLOSURE, manifestExtra: { dsh: {} } })
    expect(readLocalBundleEntries('path', plain)).toEqual({ ok: true, entries: [] })
  })
})

describe('readPreparedBundle', () => {
  it('proves the declared and transitive closure the record and lockfile agree on', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, {
      ...CLOSURE,
      packages: [
        { name: 'left-pad', version: '1.3.0', integrity: 'sha512-left-pad', dependencies: { nested: '2.0.0' } },
        { name: 'nested', version: '2.0.0', integrity: 'sha512-nested' },
      ],
    })
    const read = prepared(directory)
    expect(read.closure).toMatchObject({
      format: 'dsh-prepared-bundle/v1', offline: 'proven',
      // A proven closure makes no claim about the target store or about the modules importing.
      store: 'unverified', loadable: 'unverified',
      packages: [{ name: 'left-pad', version: '1.3.0' }, { name: 'nested', version: '2.0.0' }],
      hostProvided: [], peers: [], installScripts: [], native: [], problems: [],
    })
    expect(read.closure.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(read.manifest).toMatchObject({ name: 'dsh-local', version: '2.0.0' })
  })

  it('changes the fingerprint when the manifest or the record changes', () => {
    const directory = join(root(), 'prepared')
    const fixture = writePreparedBundle(directory, CLOSURE)
    const before = prepared(directory).closure.fingerprint
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...fixture.manifest, description: 'changed' }))
    expect(prepared(directory).closure.fingerprint).not.toBe(before)
  })

  it('changes the fingerprint when a file other than the manifest or record changes', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, { ...CLOSURE, extraFiles: { 'index.js': 'export const value = 1\n' } })
    const before = prepared(directory)
    // The metadata is untouched, so the closure still verifies; only the bytes differ.
    expect(before.closure.offline).toBe('proven')
    writeFileSync(join(directory, 'index.js'), 'export const value = 2\n')
    const after = prepared(directory)
    expect(after.closure.offline).toBe('proven')
    expect(after.closure.fingerprint).not.toBe(before.closure.fingerprint)
  })

  it('changes the fingerprint when a dependency file or an added file changes', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, { ...CLOSURE, packages: [{ name: 'left-pad', version: '1.3.0', integrity: 'sha512-left-pad' }] })
    const before = prepared(directory).closure.fingerprint
    writeFileSync(join(directory, 'node_modules/left-pad/package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'other.js' }))
    const dependencyChanged = prepared(directory).closure.fingerprint
    expect(dependencyChanged).not.toBe(before)
    writeFileSync(join(directory, 'added.js'), 'export {}\n')
    expect(prepared(directory).closure.fingerprint).not.toBe(dependencyChanged)
  })

  it('binds the bytes of a prepared archive', () => {
    const archivePath = join(root(), 'prepared.tgz')
    const fingerprintOf = (): string => {
      const read = readPreparedBundle('tarball', archivePath)
      if (!read.ok) throw new Error(read.reason)
      return read.closure.fingerprint
    }
    writePreparedArchive(archivePath, { ...CLOSURE, extraFiles: { 'index.js': 'export const value = 1\n' } })
    const before = fingerprintOf()
    writePreparedArchive(archivePath, { ...CLOSURE, extraFiles: { 'index.js': 'export const value = 2\n' } })
    expect(fingerprintOf()).not.toBe(before)
  })

  it('accepts a host-provided dependency the package declares and an optional dependency it skipped', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, {
      dependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
      omitImporterDeps: ['fsevents'],
      hostProvided: ['@deepseek-ai/cordis'],
      packages: [],
    })
    expect(prepared(directory).closure).toMatchObject({ offline: 'proven', hostProvided: ['@deepseek-ai/cordis'], packages: [], problems: [] })
  })

  it('checks that the installation actually supplies a host-provided dependency', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, {
      dependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      hostProvided: ['@deepseek-ai/cordis'],
      packages: [],
    })
    // Without installation context the record's own claim stands, as before.
    expect(prepared(directory).closure.offline).toBe('proven')

    const missing = readPreparedBundle('path', directory, { supplies: () => false })
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.closure.offline).toBe('not-proven')
      expect(reasons(missing.closure.problems)).toContain('is host-provided, but the installation does not supply it')
    }
    const supplied = readPreparedBundle('path', directory, { supplies: () => true })
    expect(supplied.ok).toBe(true)
    if (supplied.ok) expect(supplied.closure).toMatchObject({ offline: 'proven', problems: [] })
  })

  it('marks an ordinary package without a record as not proving its closure', () => {
    const directory = join(root(), 'plain')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), MANIFEST)
    const read = prepared(directory)
    expect(read.closure).toMatchObject({ format: null, offline: 'not-proven' })
    expect(reasons(read.closure.problems)).toContain('carries no dsh-prepared-bundle.json')
  })

  it('reads a prepared archive', () => {
    const archivePath = join(root(), 'prepared.tgz')
    writePreparedArchive(archivePath, CLOSURE)
    const read = readPreparedBundle('tarball', archivePath)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.closure).toMatchObject({ format: 'dsh-prepared-bundle/v1', offline: 'proven' })
  })

  it.each(['v9-peers', 'v6'] as const)('reads %s lockfile keys', (lockFormat) => {
    const directory = join(root(), lockFormat)
    writePreparedBundle(directory, { ...CLOSURE, lockFormat })
    expect(prepared(directory).closure.offline).toBe('proven')
  })

  it('marks a packed archive without a record as not proving its closure', () => {
    const archivePath = join(root(), 'packed.tgz')
    writeFileSync(archivePath, archive([{ name: 'package/package.json', body: MANIFEST }]))
    const read = readPreparedBundle('tarball', archivePath)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.closure.offline).toBe('not-proven')
      expect(reasons(read.closure.problems)).toContain('carries no dsh-prepared-bundle.json')
    }
  })

  it('refuses a path that is not a package directory', () => {
    const file = join(root(), 'file.json')
    writeFileSync(file, '{}')
    expect(readPreparedBundle('path', file)).toEqual({
      ok: false, problem: 'not-a-package', reason: 'the path is not a package directory',
    })
  })

  it.each([
    ['a lockfile the record does not match', { lockSha256: '0'.repeat(64) }, 'does not match the sha256'],
    ['a record naming another package', { recordName: 'other' }, 'while package.json names'],
    ['an unsupported format', { recordPatch: { format: 'dsh-prepared-bundle/v2' } }, 'is not supported'],
    ['a dependency the record omits', { omitRecordPackages: ['left-pad'] }, 'the record does not list it'],
    ['a dependency whose installed copy is missing', { omitFiles: ['left-pad'] }, 'does not carry the installed copy'],
    ['a declared dependency the lockfile omits', { omitImporterDeps: ['left-pad'] }, 'does not record this declared dependency'],
    [
      'an install script the record does not declare',
      { packages: [{ name: 'left-pad', version: '1.3.0', integrity: 'sha512-left-pad', requiresBuild: true }], recordPatch: { installScripts: [] } },
      'does not declare',
    ],
    [
      'a native package the record does not declare',
      { packages: [{ name: 'left-pad', version: '1.3.0', integrity: 'sha512-left-pad', os: [process.platform] }], recordPatch: { native: [] } },
      'does not declare',
    ],
    ['an integrity the record does not carry', { recordPatch: { packages: [{ name: 'left-pad', version: '1.3.0', path: 'node_modules/left-pad' }] } }, 'records no lockfile integrity'],
    ['a peer dependency nothing supplies', { peerDependencies: { react: '^19.0.0' } }, 'is neither host-provided nor part of the closure'],
    ['a path outside the package', { recordPatch: { packages: [{ name: 'left-pad', version: '1.3.0', path: '../left-pad' }] } }, 'must name a package, its version, and a path relative'],
    ['a host-provided dependency the manifest does not declare', { hostProvided: ['ghost'] }, 'declares no such dependency'],
  ] as const)('marks a bundle with %s as not proven', (_name, override, reason) => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, { ...CLOSURE, ...override })
    const read = prepared(directory)
    expect(read.closure.offline).toBe('not-proven')
    expect(reasons(read.closure.problems)).toContain(reason)
  })
})

describe('readPreparedBundle dependency tarballs', () => {
  /** One prepared bundle whose record carries the tarball for its dependency. */
  const WITH_TARBALL: PreparedBundleOptions = {
    ...CLOSURE,
    tarballs: [{ name: 'left-pad', version: '1.3.0', file: 'tarballs/left-pad-1.3.0.tgz', content: 'left-pad-tarball-bytes' }],
  }

  it('proves a closure whose dependency is delivered as a tarball and lists the tarball for the installer', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, WITH_TARBALL)
    const read = prepared(directory)
    expect(read.closure.offline).toBe('proven')
    expect(read.tarballs).toEqual([{
      name: 'left-pad', version: '1.3.0', file: 'tarballs/left-pad-1.3.0.tgz',
      integrity: `sha512-${createHash('sha512').update('left-pad-tarball-bytes').digest('base64')}`,
    }])
  })

  it('refuses a record whose tarball the package does not carry, naming the file', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, WITH_TARBALL)
    rmSync(join(directory, 'tarballs', 'left-pad-1.3.0.tgz'))
    const read = prepared(directory)
    expect(read.closure.offline).toBe('not-proven')
    expect(reasons(read.closure.problems)).toContain('missing from the package')
    expect(reasons(read.closure.problems)).toContain('left-pad@1.3.0')
  })

  it('refuses a tarball whose bytes changed after the record was written', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, WITH_TARBALL)
    writeFileSync(join(directory, 'tarballs', 'left-pad-1.3.0.tgz'), 'tampered')
    const read = prepared(directory)
    expect(read.closure.offline).toBe('not-proven')
    expect(reasons(read.closure.problems)).toContain('does not match its recorded sha512 integrity')
  })

  it('refuses a tarball entry with a path outside the package or without a sha512 integrity', () => {
    const outside = join(root(), 'outside')
    writePreparedBundle(outside, { ...CLOSURE, recordPatch: { tarballs: [{ name: 'left-pad', version: '1.3.0', file: '../x.tgz', integrity: 'sha512-AAAA' }] } })
    expect(reasons(prepared(outside).closure.problems)).toContain('must name a package, its version, a file relative to the package')
    const unsigned = join(root(), 'unsigned')
    writePreparedBundle(unsigned, { ...CLOSURE, recordPatch: { tarballs: [{ name: 'left-pad', version: '1.3.0', file: 'x.tgz', integrity: 'md5-AAAA' }] } })
    expect(reasons(prepared(unsigned).closure.problems)).toContain('not a sha512 digest')
  })

  it('keeps a v1 record prepared before tarballs existed valid', () => {
    const directory = join(root(), 'prepared')
    writePreparedBundle(directory, CLOSURE)
    const read = prepared(directory)
    expect(read.closure.offline).toBe('proven')
    expect(read.tarballs).toEqual([])
  })
})
