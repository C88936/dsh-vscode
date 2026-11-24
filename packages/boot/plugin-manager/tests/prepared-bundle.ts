/**
 * Fixtures for a prepared local bundle: a package directory, or a `.tgz` holding the same files, with a
 * `dsh-prepared-bundle/v1` record generated from pnpm's lock data.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { stringify } from 'yaml'

/** One package pnpm's lockfile records for the prepared bundle. */
export interface LockPackageFixture {
  readonly name: string
  readonly version: string
  readonly integrity?: string
  readonly requiresBuild?: boolean
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  /** Dependency name to the exact resolved version, recorded in the lockfile snapshot. */
  readonly dependencies?: Readonly<Record<string, string>>
}

/** How to prepare one fixture bundle. */
export interface PreparedBundleOptions {
  readonly name?: string
  readonly version?: string
  /** Declared runtime dependency ranges. */
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerOptional?: readonly string[]
  /** Other manifest fields merged into the generated package.json. */
  readonly manifestExtra?: Readonly<Record<string, unknown>>
  /** Dependencies the record says the profile or installation supplies. */
  readonly hostProvided?: readonly string[]
  readonly packages?: readonly LockPackageFixture[]
  /** Declared dependencies the lockfile importer leaves out. */
  readonly omitImporterDeps?: readonly string[]
  /** Write `dsh-prepared-bundle.json`; defaults to true. */
  readonly record?: boolean
  /** Override the recorded lockfile sha256, for a tampered or stale lockfile. */
  readonly lockSha256?: string
  readonly recordName?: string
  readonly recordVersion?: string
  /** Fields merged into the generated record. */
  readonly recordPatch?: Readonly<Record<string, unknown>>
  /** Closure packages the record leaves out. */
  readonly omitRecordPackages?: readonly string[]
  /** Closure packages whose installed copy the fixture does not write. */
  readonly omitFiles?: readonly string[]
  /** Lockfile key form: pnpm v9's `name@version`, its peer-suffixed keys, or pnpm v6's `/name/version`. */
  readonly lockFormat?: 'v9' | 'v9-peers' | 'v6'
  /** Extra files written beside the generated ones, keyed by `/`-separated path inside the package. */
  readonly extraFiles?: Readonly<Record<string, string>>
  /**
   * Dependency tarballs the record lists for an offline import.
   *
   * Each writes its bytes at `file`, records the sha512 integrity, and, when
   * the matching closure package carries no integrity of its own, uses the
   * same digest in the lockfile and record so pnpm accepts the imported store
   * content.
   */
  readonly tarballs?: readonly {
    readonly name: string
    readonly version: string
    readonly file: string
    readonly content: string
  }[]
}

/** The manifest, record, and lockfile a fixture wrote. */
export interface PreparedBundleFixture {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly record: Readonly<Record<string, unknown>>
  readonly lockfile: string
}

const NAME = 'dsh-prepared'
const VERSION = '1.0.0'

/**
 * @param options - the fixture's package and closure facts.
 * @returns the files of one prepared bundle, keyed by `/`-separated path inside the package.
 */
function bundleFiles(options: PreparedBundleOptions): { files: Map<string, string>; fixture: PreparedBundleFixture } {
  const name = options.name ?? NAME
  const version = options.version ?? VERSION
  const tarballEntries = (options.tarballs ?? []).map(tarball => ({
    ...tarball,
    integrity: `sha512-${createHash('sha512').update(tarball.content).digest('base64')}`,
  }))
  const tarballIntegrity = new Map(tarballEntries.map(entry => [`${entry.name}@${entry.version}`, entry.integrity]))
  const packages = (options.packages ?? []).map(pkg => ({
    ...pkg,
    integrity: pkg.integrity ?? tarballIntegrity.get(`${pkg.name}@${pkg.version}`),
  }))
  const optionalNames = new Set(Object.keys(options.optionalDependencies ?? {}).filter(dependency => !Object.hasOwn(options.dependencies ?? {}, dependency)))
  const resolved = new Map(packages.map(pkg => [pkg.name, pkg.version]))
  const importerDependencies: Record<string, { specifier: string; version: string }> = {}
  for (const [dependency, range] of Object.entries(options.dependencies ?? {})) {
    if (options.omitImporterDeps?.includes(dependency) === true) continue
    importerDependencies[dependency] = { specifier: range, version: resolved.get(dependency) ?? '1.0.0' }
  }
  const importerOptional: Record<string, { specifier: string; version: string }> = {}
  for (const [dependency, range] of Object.entries(options.optionalDependencies ?? {})) {
    if (options.omitImporterDeps?.includes(dependency) === true) continue
    importerOptional[dependency] = { specifier: range, version: resolved.get(dependency) ?? '1.0.0' }
  }
  const lockPackages: Record<string, Record<string, unknown>> = {}
  const snapshots: Record<string, Record<string, unknown>> = {}
  const lockFormat = options.lockFormat ?? 'v9'
  for (const pkg of packages) {
    const identity = `${pkg.name}@${pkg.version}`
    const key = lockFormat === 'v6'
      ? `/${pkg.name}/${pkg.version}`
      : lockFormat === 'v9-peers' ? `${identity}(peer@1.0.0)` : identity
    lockPackages[key] = {
      ...pkg.integrity === undefined ? {} : { resolution: { integrity: pkg.integrity } },
      ...pkg.requiresBuild === true ? { requiresBuild: true } : {},
      ...pkg.os === undefined ? {} : { os: [...pkg.os] },
      ...pkg.cpu === undefined ? {} : { cpu: [...pkg.cpu] },
      ...lockFormat === 'v6' && pkg.dependencies !== undefined ? { dependencies: { ...pkg.dependencies } } : {},
    }
    if (lockFormat !== 'v6') snapshots[key] = pkg.dependencies === undefined ? {} : { dependencies: { ...pkg.dependencies } }
  }
  // pnpm v6 records resolved versions as plain strings in the importer; v9 records objects.
  const importerOf = (dependencies: Record<string, { specifier: string; version: string }>): Record<string, unknown> =>
    lockFormat === 'v6'
      ? Object.fromEntries(Object.entries(dependencies).map(([dependency, entry]) => [dependency, entry.version]))
      : dependencies
  const lockfile = stringify({
    lockfileVersion: lockFormat === 'v6' ? '6.0' : '9.0',
    importers: {
      '.': {
        ...Object.keys(importerDependencies).length === 0 ? {} : { dependencies: importerOf(importerDependencies) },
        ...Object.keys(importerOptional).length === 0 ? {} : { optionalDependencies: importerOf(importerOptional) },
      },
    },
    packages: lockPackages,
    ...lockFormat === 'v6' ? {} : { snapshots },
  })
  const manifest: Record<string, unknown> = {
    name, version, dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...options.manifestExtra,
    ...options.dependencies === undefined ? {} : { dependencies: options.dependencies },
    ...options.optionalDependencies === undefined ? {} : { optionalDependencies: options.optionalDependencies },
    ...options.peerDependencies === undefined ? {} : { peerDependencies: options.peerDependencies },
    ...options.peerOptional === undefined ? {} : {
      peerDependenciesMeta: Object.fromEntries(options.peerOptional.map(peer => [peer, { optional: true }])),
    },
  }
  const omitted = new Set(options.omitRecordPackages ?? [])
  const record: Record<string, unknown> = {
    format: 'dsh-prepared-bundle/v1',
    name: options.recordName ?? name,
    version: options.recordVersion ?? version,
    lockfile: { path: 'pnpm-lock.yaml', sha256: options.lockSha256 ?? createHash('sha256').update(lockfile).digest('hex') },
    hostProvided: [...options.hostProvided ?? []],
    packages: packages.filter(pkg => !omitted.has(pkg.name)).map(pkg => ({
      name: pkg.name,
      version: pkg.version,
      path: `node_modules/${pkg.name}`,
      ...pkg.integrity === undefined ? {} : { integrity: pkg.integrity },
      ...optionalNames.has(pkg.name) ? { optional: true } : {},
    })),
    installScripts: packages.filter(pkg => pkg.requiresBuild === true).map(pkg => `${pkg.name}@${pkg.version}`),
    native: packages.filter(pkg => (pkg.os?.length ?? 0) > 0 || (pkg.cpu?.length ?? 0) > 0).map(pkg => `${pkg.name}@${pkg.version}`),
    ...tarballEntries.length === 0
      ? {}
      : { tarballs: tarballEntries.map(entry => ({ name: entry.name, version: entry.version, file: entry.file, integrity: entry.integrity })) },
  }
  const files = new Map<string, string>()
  files.set('package.json', JSON.stringify(manifest))
  files.set('cordis.patch.yml', '[]\n')
  files.set('pnpm-lock.yaml', lockfile)
  if (options.record !== false) {
    files.set('dsh-prepared-bundle.json', JSON.stringify({ ...record, ...options.recordPatch }))
  }
  for (const pkg of packages) {
    if (options.omitFiles?.includes(pkg.name) === true) continue
    files.set(`node_modules/${pkg.name}/package.json`, JSON.stringify({ name: pkg.name, version: pkg.version }))
  }
  for (const [relative, body] of Object.entries(options.extraFiles ?? {})) files.set(relative, body)
  for (const tarball of tarballEntries) files.set(tarball.file, tarball.content)
  return { files, fixture: { manifest, record, lockfile } }
}

/**
 * Write a prepared bundle directory.
 * @param directory - target directory, created when absent.
 * @param options - the fixture's package and closure facts.
 * @returns the manifest, record, and lockfile the directory carries.
 */
export function writePreparedBundle(directory: string, options: PreparedBundleOptions = {}): PreparedBundleFixture {
  const { files, fixture } = bundleFiles(options)
  for (const [relative, body] of files) {
    const target = join(directory, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  return fixture
}

/**
 * Write a prepared bundle archive: the same files under npm's `package/` prefix.
 * @param archive - target `.tgz` path.
 * @param options - the fixture's package and closure facts.
 * @returns the manifest, record, and lockfile the archive carries.
 */
export function writePreparedArchive(archive: string, options: PreparedBundleOptions = {}): PreparedBundleFixture {
  const { files, fixture } = bundleFiles(options)
  const blocks: Buffer[] = []
  for (const [relative, body] of files) {
    const bytes = Buffer.from(body)
    const header = Buffer.alloc(512)
    header.write(`package/${relative}`, 0, 100, 'utf8')
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  mkdirSync(dirname(archive), { recursive: true })
  writeFileSync(archive, gzipSync(Buffer.concat(blocks)))
  return fixture
}
