/**
 * Identity and offline closure of a prepared local bundle: a package directory, or a `.tgz` prepared from one. The
 * manager reads both before installing, so a replacement names the package and its version, and a bundle that carries
 * a `dsh-prepared-bundle/v1` record proves which dependency closure the installation may rely on. The fingerprint binds
 * the bytes the bundle actually carries, so a file changed between inspection and installation is detected.
 * @module @deepseek-ai/dsh-plugin-manager/local-bundle
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import type {
  PreparedBundleClosure, PreparedBundlePackage, PreparedBundlePeer, PreparedBundleProblem,
} from './types.ts'

/** The spec form a prepared bundle takes: a package directory, or a gzip-compressed tarball. */
export type LocalBundleKind = 'path' | 'tarball'

/** The closure record a prepared bundle carries beside its `package.json`. */
const RECORD_FILE = 'dsh-prepared-bundle.json'

/** The only prepared-bundle format this reader understands. */
const PREPARED_FORMAT = 'dsh-prepared-bundle/v1'

/** Largest `package.json` this reader decodes. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/** Largest closure record this reader decodes. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024

/** Largest pnpm lockfile this reader decodes. */
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024

/** Largest prepared archive this reader decompresses. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** Most packages one verified dependency closure may hold. */
const MAX_CLOSURE_PACKAGES = 4000

/** Most dependency tarballs one prepared bundle may carry. */
const MAX_CLOSURE_TARBALLS = 512

/** Largest dependency tarball one prepared bundle may carry. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** One dependency tarball a prepared bundle carries for an offline install. */
export interface PreparedBundleTarball {
  /** Package the tarball contains. */
  readonly name: string
  /** Version the tarball contains. */
  readonly version: string
  /** Path of the tarball relative to the package root. */
  readonly file: string
  /** `sha512-<base64>` the tarball must match. */
  readonly integrity: string
}

/** Fixed tar header and data block size. */
const TAR_BLOCK = 512

/** Most archive entries a scan reads before giving up on a malformed or hostile archive. */
const MAX_ARCHIVE_ENTRIES = 20_000

/** Dependency values pnpm resolved outside a registry, which v1 cannot verify. */
const NON_REGISTRY_VERSION = /^(?:git|git\+[a-z]+|github|gitlab|bitbucket|gist|https?|link|file|workspace|npm|jsr):/iu

/** Names the file set a fingerprint covers, so a fingerprint from another scheme is never compared with this one. */
const FINGERPRINT_DOMAIN = 'dsh-prepared-content/v1'

/** Most files one package directory may carry before its content cannot be bound. */
const MAX_CONTENT_FILES = 50_000

/** Most bytes one package directory may carry before its content cannot be bound. */
const MAX_CONTENT_BYTES = 1024 * 1024 * 1024

/** The manifest a prepared local bundle carries. */
export type LocalBundleManifest =
  | { readonly ok: true; readonly manifest: object }
  | { readonly ok: false; readonly problem: 'not-a-package'; readonly reason: string }

/** A prepared bundle's manifest and the closure facts its record proves. */
export type PreparedBundleRead =
  | {
    readonly ok: true
    readonly manifest: object
    readonly closure: PreparedBundleClosure
    /** Dependency tarballs the record lists, verified against the bundle's bytes. */
    readonly tarballs: readonly PreparedBundleTarball[]
  }
  | { readonly ok: false; readonly problem: 'not-a-package'; readonly reason: string }

/** Facts only the installation can supply while reading a prepared bundle. */
export interface PreparedBundleContext {
  /**
   * Whether the installation supplies one package name, such as a dependency the record calls host-provided.
   * @param name - npm package name.
   * @returns whether that installation resolves and carries the package.
   */
  readonly supplies: (name: string) => boolean
}

/**
 * Read the package manifest a prepared directory or archive carries.
 * @param kind - the spec form: a package directory, or a gzip-compressed tarball.
 * @param path - absolute directory or archive path.
 * @returns the decoded manifest, or why the input is not a readable package.
 */
export function readLocalBundleManifest(kind: LocalBundleKind, path: string): LocalBundleManifest {
  try {
    return kind === 'path' ? directoryManifest(path) : archiveManifest(path)
  } catch (error) {
    return { ok: false, problem: 'not-a-package', reason: `the package cannot be read: ${messageOf(error)}` }
  }
}

/**
 * Read a prepared bundle's manifest and verify the dependency closure its `dsh-prepared-bundle/v1` record declares.
 * Every check reads only files inside the package, so the caller can decide whether the install may rely on an
 * offline resolution. A record that is absent, unreadable, inconsistent with the lockfile, or names an unsupported
 * dependency leaves `closure.offline` at `not-proven` and lists each gap in `closure.problems`. The fingerprint covers
 * every file the bundle carries, not only the manifest and record, so code or dependency bytes changed after an
 * inspection produce a different fingerprint.
 * @param kind - the spec form: a package directory, or a gzip-compressed tarball.
 * @param path - absolute directory or archive path.
 * @param context - what the installation supplies, when the caller can check it.
 * @returns the decoded manifest with the closure facts, or why the input is not a readable package.
 */
export function readPreparedBundle(
  kind: LocalBundleKind,
  path: string,
  context?: PreparedBundleContext,
): PreparedBundleRead {
  try {
    const bundle = openBundle(kind, path)
    const manifestBytes = bundle.files.read('package.json')
    if (manifestBytes === undefined) {
      const reason = kind === 'path' ? 'the package directory carries no package.json' : 'the tarball carries no package/package.json'
      return { ok: false, problem: 'not-a-package', reason }
    }
    const manifest = decodeManifest(manifestBytes, 'package.json')
    if (!manifest.ok) return manifest
    const closure = readClosure(bundle.files, bundle.digest, manifestBytes, manifest.manifest, context)
    return {
      ok: true,
      manifest: manifest.manifest,
      closure: closure.closure,
      tarballs: closure.tarballs,
    }
  } catch (error) {
    if (error instanceof NotAPackageError) return { ok: false, problem: 'not-a-package', reason: error.message }
    return { ok: false, problem: 'not-a-package', reason: `the package cannot be read: ${messageOf(error)}` }
  }
}

/** One opened bundle: the files it exposes, and a digest of everything it carries. */
interface OpenedBundle {
  readonly files: BundleFiles
  /** Digest of the bundle's own bytes: the archive file, or every file the directory carries. */
  readonly digest: string
}

/**
 * Read one file a prepared directory or archive carries.
 *
 * A caller that must hand a file to another program (importing a dependency
 * tarball into a store) reads it here, so an archive's entries are available
 * exactly as a directory's files are.
 * @param kind - the spec form: a package directory, or a gzip-compressed tarball.
 * @param path - absolute directory or archive path.
 * @param file - path relative to the package root.
 * @returns the file bytes, or undefined when the package does not carry that path.
 */
export function readPreparedBundleFile(kind: LocalBundleKind, path: string, file: string): Uint8Array | undefined {
  return openBundle(kind, path).files.read(file)
}

/** One overlay entry a prepared bundle would insert, as a pre-install ownership check reads it. */
export interface LocalBundleEntry {
  /** Entry id the bundle assigns, when it names one. */
  readonly id?: string
  /** Module or package the entry mounts, when it names one. */
  readonly name?: string
}

/** The entries a prepared bundle would insert, or why they cannot be read. */
export type LocalBundleEntries =
  | { readonly ok: true; readonly entries: readonly LocalBundleEntry[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Read the overlay entries a prepared bundle would insert, before it is installed.
 *
 * A package this manager has never seen cannot be checked by name for rows that mount plugin management, so the
 * candidate's own patch files are read first. The entries come from the same `dsh.bundle.patch` declaration the
 * profile composes, including a tarball's entries, which a filesystem check could not reach.
 * @param kind - the spec form: a package directory, or a gzip-compressed tarball.
 * @param path - absolute directory or archive path.
 * @returns the inserted entries, or why the package and its patch cannot be read.
 */
export function readLocalBundleEntries(kind: LocalBundleKind, path: string): LocalBundleEntries {
  try {
    const bundle = openBundle(kind, path)
    const manifestBytes = bundle.files.read('package.json')
    if (manifestBytes === undefined) {
      const reason = kind === 'path' ? 'the package directory carries no package.json' : 'the tarball carries no package/package.json'
      return { ok: false, reason }
    }
    const manifest = decodeManifest(manifestBytes, 'package.json')
    if (!manifest.ok) return { ok: false, reason: manifest.reason }
    const declared = patchFilesOf(manifest.manifest)
    if (!declared.ok) return { ok: false, reason: declared.reason }
    const entries: LocalBundleEntry[] = []
    for (const file of declared.files) {
      const bytes = bundle.files.read(file)
      if (bytes === undefined) {
        return { ok: false, reason: `the bundle declares ${file}, but the package does not carry it` }
      }
      entries.push(...insertedEntries(parseYamlBytes(bytes, file)))
    }
    return { ok: true, entries }
  } catch (error) {
    if (error instanceof NotAPackageError) return { ok: false, reason: error.message }
    return { ok: false, reason: `the package cannot be read: ${messageOf(error)}` }
  }
}

/**
 * Read the patch files one manifest's `dsh.bundle` declaration names.
 * @param manifest - decoded package manifest.
 * @returns the declared files, or why the declaration is unusable.
 */
function patchFilesOf(manifest: object): { ok: true; files: readonly string[] } | { ok: false; reason: string } {
  const dsh = recordOf(field(manifest, 'dsh'))
  const bundle = dsh === undefined ? undefined : recordOf(field(dsh, 'bundle'))
  if (bundle === undefined) return { ok: true, files: [] }
  const declared: unknown = field(bundle, 'patch')
  const listed: unknown = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(listed) || !listed.every(file => typeof file === 'string')) {
    return { ok: false, reason: 'dsh.bundle.patch must be a file path or a list of file paths' }
  }
  const files: string[] = []
  for (const file of listed) {
    // A bundle names its patch file relative to the package, sometimes with a leading `./`.
    const relative = relativePath(String(file).replace(/^\.\//u, ''))
    if (relative === undefined) return { ok: false, reason: `${String(file)} is not a path inside the package` }
    files.push(relative)
  }
  return { ok: true, files }
}

/**
 * @param bytes - one patch file's bytes.
 * @param name - the file the bytes came from, for the failure message.
 * @returns the parsed patch document, or undefined when it is unreadable.
 */
function parseYamlBytes(bytes: Uint8Array, name: string): unknown {
  try {
    return parseYaml(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new NotAPackageError(`${name} is not readable YAML: ${messageOf(error)}`)
  }
}

/**
 * Collect the `insert` entries one parsed patch document declares.
 * @param document - parsed patch document: one entry list, or a list of them.
 * @returns every inserted entry, in document order.
 */
function insertedEntries(document: unknown): LocalBundleEntry[] {
  const lists = Array.isArray(document) ? document : [document]
  const entries: LocalBundleEntry[] = []
  for (const list of lists) {
    const record = recordOf(list)
    if (record === undefined) continue
    const insert: unknown = field(record, 'insert')
    if (insert === undefined) continue
    const rows = Array.isArray(insert) ? insert : [insert]
    for (const row of rows) {
      const entry = recordOf(row)
      if (entry === undefined) continue
      const id = stringField(entry, 'id')
      const name = stringField(entry, 'name')
      if (id === undefined && name === undefined) continue
      entries.push({ ...id === undefined ? {} : { id }, ...name === undefined ? {} : { name } })
    }
  }
  return entries
}

/**
 * Open one bundle and digest its content.
 * @param kind - the spec form.
 * @param path - absolute directory or archive path.
 * @returns its files and content digest.
 * @throws NotAPackageError when the path cannot be bound as a package.
 */
function openBundle(kind: LocalBundleKind, path: string): OpenedBundle {
  return kind === 'path'
    ? { files: directoryFiles(path), digest: directoryContentDigest(path) }
    : { files: archiveFiles(path), digest: digestOf(readFileSync(path)) }
}

/** A refusal naming why a path is not a package this reader can inspect. */
class NotAPackageError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'NotAPackageError'
  }
}

/** Files a prepared bundle exposes, named relative to its package root. */
interface BundleFiles {
  read(relative: string): Uint8Array | undefined
}

/**
 * @param directory - package directory.
 * @returns the directory's files.
 */
function directoryFiles(directory: string): BundleFiles {
  const stats = statSync(directory)
  if (!stats.isDirectory()) throw new NotAPackageError('the path is not a package directory')
  return {
    read: (relative) => {
      try {
        return readFileSync(join(directory, relative))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}

/**
 * @param archive - gzip-compressed tarball.
 * @returns the archive's files, with npm's `package/` prefix removed.
 */
function archiveFiles(archive: string): BundleFiles {
  const stats = statSync(archive)
  if (!stats.isFile()) throw new NotAPackageError('the tarball is not a file')
  if (stats.size > MAX_ARCHIVE_BYTES) throw new NotAPackageError(`the tarball is larger than ${String(MAX_ARCHIVE_BYTES)} bytes`)
  const entries = indexTar(gunzipSync(readFileSync(archive), { maxOutputLength: MAX_ARCHIVE_BYTES }))
  return { read: relative => entries.get(`package/${relative}`) ?? entries.get(relative) }
}

/**
 * Digest every file a package directory carries, so a changed entry, script, or dependency byte changes the
 * fingerprint even when the version does not.
 *
 * Entries are visited in name order with `/` separators, which makes the digest independent of the directory
 * enumeration order. A symbolic link contributes its target name and is not followed, so a link cannot pull an
 * unbounded outside tree into the digest. Exceeding the file or byte bound is a refusal rather than a partial digest:
 * a fingerprint that silently covered only some files could compare equal for two different bundles.
 * @param directory - package directory.
 * @returns the digest of its content.
 * @throws NotAPackageError when the package carries more files or bytes than can be bound.
 */
export function directoryContentDigest(directory: string): string {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = (relative: string): void => {
    const absolute = relative === '' ? directory : join(directory, relative)
    const entries = readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      const target = join(directory, child)
      files++
      if (files > MAX_CONTENT_FILES) {
        throw new NotAPackageError(`the package carries more than ${String(MAX_CONTENT_FILES)} entries, so its content cannot be bound`)
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${child}\0`)
        walk(child)
        continue
      }
      if (entry.isSymbolicLink()) {
        hash.update(`link\0${child}\0${readlinkSync(target)}\0`)
        continue
      }
      if (!entry.isFile()) {
        hash.update(`entry\0${child}\0`)
        continue
      }
      const content = readFileSync(target)
      bytes += content.byteLength
      if (bytes > MAX_CONTENT_BYTES) {
        throw new NotAPackageError(`the package carries more than ${String(MAX_CONTENT_BYTES)} bytes, so its content cannot be bound`)
      }
      hash.update(`file\0${child}\0${String(content.byteLength)}\0`)
      hash.update(content)
    }
  }
  walk('')
  return hash.digest('hex')
}

/**
 * Check that the installation actually supplies every dependency the record calls host-provided.
 *
 * The record is the bundle's own claim; the installation is a separate fact. A profile that lost the package, or an
 * installation that never carried it, would otherwise meet an unresolved import after a proven install.
 * @param hostProvided - names the record declares the profile or installation supplies.
 * @param context - the installation lookup, when the caller has one.
 * @returns one problem per name the installation does not supply.
 */
function availabilityProblems(
  hostProvided: readonly string[],
  context: PreparedBundleContext | undefined,
): PreparedBundleProblem[] {
  if (context === undefined) return []
  const problems: PreparedBundleProblem[] = []
  for (const name of hostProvided) {
    if (context.supplies(name)) continue
    problems.push({
      kind: 'unproven', name,
      reason: `${name} is host-provided, but the installation does not supply it`,
    })
  }
  return problems
}

/**
 * Read a prepared bundle's manifest and its closure record, then verify every dependency the lockfile resolves.
 * @param files - the package's files.
 * @param contentDigest - digest of every file the bundle carries.
 * @param manifestBytes - the verified manifest bytes.
 * @param manifest - the decoded manifest.
 * @param context - what the installation supplies, when the caller can check it.
 * @returns the closure facts, proven only when no problem remains, and the verified dependency tarballs.
 */
function readClosure(
  files: BundleFiles,
  contentDigest: string,
  manifestBytes: Uint8Array,
  manifest: object,
  context: PreparedBundleContext | undefined,
): { readonly closure: PreparedBundleClosure; readonly tarballs: readonly PreparedBundleTarball[] } {
  const recordBytes = files.read(RECORD_FILE)
  const fingerprint = fingerprintOf(contentDigest, manifestBytes, recordBytes)
  const peers = peerDependencies(manifest)
  const base: PreparedBundleClosure = {
    format: null, recorded: recordBytes !== undefined, offline: 'not-proven', store: 'unverified', loadable: 'unverified',
    fingerprint, packages: [], hostProvided: [], peers, installScripts: [], native: [], problems: [],
  }
  if (recordBytes === undefined) {
    return {
      closure: {
        ...base,
        problems: [{
          kind: 'unproven', name: RECORD_FILE,
          reason: `the package carries no ${RECORD_FILE}, so its dependency closure is not proven`,
        }],
      },
      tarballs: [],
    }
  }
  if (recordBytes.byteLength > MAX_RECORD_BYTES) {
    return {
      closure: {
        ...base,
        problems: [{ kind: 'unproven', name: RECORD_FILE, reason: `${RECORD_FILE} is larger than ${String(MAX_RECORD_BYTES)} bytes` }],
      },
      tarballs: [],
    }
  }
  const parsedRecord = parseRecord(parseJson(recordBytes))
  const problems: PreparedBundleProblem[] = [...parsedRecord.problems]
  const record = parsedRecord.record
  if (record === undefined) return { closure: { ...base, problems }, tarballs: [] }
  const manifestName = stringField(manifest, 'name')
  const manifestVersion = stringField(manifest, 'version')
  if (record.name !== manifestName || record.version !== manifestVersion) {
    problems.push({
      kind: 'unproven', name: RECORD_FILE,
      reason: `the record names ${record.name ?? '(none)'}@${record.version ?? '(none)'}, while package.json names ${manifestName ?? '(none)'}@${manifestVersion ?? '(none)'}`,
    })
  }
  const lock = readLockfile(files, record, problems)
  const hostProvided = new Set(record.hostProvided)
  if (lock !== undefined) {
    const resolution = resolveLockClosure(lock, manifest, hostProvided)
    problems.push(...resolution.problems)
    problems.push(...compareClosure(files, manifest, record, resolution, peers, hostProvided))
  }
  problems.push(...availabilityProblems(record.hostProvided, context))
  verifyTarballs(files, record.tarballs, problems)
  return {
    closure: {
      format: PREPARED_FORMAT,
      recorded: true,
      offline: problems.length === 0 ? 'proven' : 'not-proven',
      store: 'unverified',
      loadable: 'unverified',
      fingerprint,
      packages: record.packages.map((pkg): PreparedBundlePackage => ({ name: pkg.name, version: pkg.version })),
      hostProvided: [...record.hostProvided],
      peers,
      installScripts: [...record.installScripts].sort(),
      native: [...record.native].sort(),
      problems,
    },
    tarballs: record.tarballs,
  }
}

/**
 * Verify the bytes of every dependency tarball a record lists.
 *
 * A missing or changed tarball must fail before the profile is touched: the
 * install would otherwise import an incomplete closure and report the gap only
 * after pnpm had rewritten the profile.
 * @param files - the package's files.
 * @param tarballs - the tarballs the record lists.
 * @param problems - the accumulated problems to extend.
 */
function verifyTarballs(
  files: BundleFiles,
  tarballs: readonly PreparedBundleTarball[],
  problems: PreparedBundleProblem[],
): void {
  for (const tarball of tarballs) {
    let bytes: Uint8Array | undefined
    try {
      bytes = files.read(tarball.file)
    } catch {
      bytes = undefined
    }
    if (bytes === undefined) {
      problems.push({
        kind: 'unproven', name: tarball.file,
        reason: `the dependency tarball for ${tarball.name}@${tarball.version} is missing from the package`,
      })
      continue
    }
    if (bytes.byteLength > MAX_TARBALL_BYTES) {
      problems.push({
        kind: 'unproven', name: tarball.file,
        reason: `the dependency tarball for ${tarball.name}@${tarball.version} is larger than ${String(MAX_TARBALL_BYTES)} bytes`,
      })
      continue
    }
    const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (digest !== tarball.integrity) {
      problems.push({
        kind: 'unproven', name: tarball.file,
        reason: `the dependency tarball for ${tarball.name}@${tarball.version} does not match its recorded sha512 integrity`,
      })
    }
  }
}

/** One dependency the closure record lists as installed beside the package. */
interface RecordedPackage {
  readonly name: string
  readonly version: string
  /** Path of the installed copy, relative to the package root. */
  readonly path: string
  readonly optional: boolean
  readonly integrity: string | undefined
}

/** The `dsh-prepared-bundle/v1` record a prepared bundle carries. */
interface ClosureRecord {
  readonly name: string | undefined
  readonly version: string | undefined
  readonly lockfile: { readonly path: string; readonly sha256: string } | undefined
  readonly hostProvided: readonly string[]
  readonly packages: readonly RecordedPackage[]
  readonly tarballs: readonly PreparedBundleTarball[]
  readonly installScripts: readonly string[]
  readonly native: readonly string[]
}

/**
 * Validate one closure record's fields.
 * @param value - the parsed record document.
 * @returns the record when its fields are usable, and every field problem found.
 */
function parseRecord(value: unknown): { record?: ClosureRecord; problems: PreparedBundleProblem[] } {
  const problems: PreparedBundleProblem[] = []
  const document = recordOf(value)
  if (document === undefined) return { problems: [{ kind: 'unproven', name: RECORD_FILE, reason: 'the record is not a JSON object' }] }
  const format = stringField(document, 'format')
  if (format === undefined) return { problems: [{ kind: 'unproven', name: RECORD_FILE, reason: 'the record names no format' }] }
  if (format !== PREPARED_FORMAT) {
    return {
      problems: [{ kind: 'unproven', name: RECORD_FILE, reason: `the prepared-bundle format ${format} is not supported; v1 requires ${PREPARED_FORMAT}` }],
    }
  }
  const name = stringField(document, 'name')
  const version = stringField(document, 'version')
  if (name === undefined || version === undefined) problems.push({ kind: 'unproven', name: RECORD_FILE, reason: 'the record names no package or version' })
  const lockfileValue = recordOf(document.lockfile)
  const lockPath = lockfileValue === undefined ? undefined : stringField(lockfileValue, 'path')
  const lockSha = lockfileValue === undefined ? undefined : stringField(lockfileValue, 'sha256')
  let lockfile: ClosureRecord['lockfile']
  if (lockPath === undefined || lockSha === undefined) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: 'the record names no lockfile and its sha256' })
  } else {
    const safe = relativePath(lockPath)
    if (safe === undefined) problems.push({ kind: 'unsupported', name: lockPath, reason: 'the lockfile path must be relative to the package and stay inside it' })
    else if (!/^[0-9a-f]{64}$/iu.test(lockSha)) problems.push({ kind: 'unproven', name: lockPath, reason: 'the recorded lockfile sha256 is not a hex digest' })
    else lockfile = { path: safe, sha256: lockSha.toLowerCase() }
  }
  const hostProvided = readStrings(document.hostProvided, 'hostProvided', problems) ?? []
  const installScripts = readStrings(document.installScripts, 'installScripts', problems) ?? []
  const native = readStrings(document.native, 'native', problems) ?? []
  const packages: RecordedPackage[] = []
  if (!Array.isArray(document.packages)) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: 'the record lists no packages array' })
  } else {
    for (const [index, item] of document.packages.entries()) {
      const entry = recordOf(item)
      if (entry === undefined) {
        problems.push({ kind: 'unproven', name: `packages[${String(index)}]`, reason: 'must be a JSON object' })
        continue
      }
      const pkgName = stringField(entry, 'name')
      const pkgVersion = stringField(entry, 'version')
      const pkgPath = stringField(entry, 'path')
      const safe = pkgPath === undefined ? undefined : relativePath(pkgPath)
      if (pkgName === undefined || pkgVersion === undefined || safe === undefined) {
        problems.push({
          kind: 'unproven', name: `packages[${String(index)}]`,
          reason: 'must name a package, its version, and a path relative to the package',
        })
        continue
      }
      const integrity = stringField(entry, 'integrity')
      packages.push({ name: pkgName, version: pkgVersion, path: safe, optional: entry.optional === true, integrity })
    }
  }
  const tarballs = parseRecordedTarballs(document.tarballs, problems)
  return { record: { name, version, lockfile, hostProvided, packages, tarballs, installScripts, native }, problems }
}

/**
 * Validate the optional `tarballs` list one record carries.
 *
 * The list is optional so a v1 record prepared before it existed keeps its
 * meaning; a record that lists tarballs must name a readable path and an
 * integrity for each one.
 * @param value - the record's `tarballs` field.
 * @param problems - the accumulated problems to extend.
 * @returns the usable tarballs, in record order.
 */
function parseRecordedTarballs(value: unknown, problems: PreparedBundleProblem[]): PreparedBundleTarball[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: 'tarballs must be an array when the record lists it' })
    return []
  }
  if (value.length > MAX_CLOSURE_TARBALLS) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: `the record lists more than ${String(MAX_CLOSURE_TARBALLS)} tarballs` })
    return []
  }
  const tarballs: PreparedBundleTarball[] = []
  for (const [index, item] of value.entries()) {
    const entry = recordOf(item)
    if (entry === undefined) {
      problems.push({ kind: 'unproven', name: `tarballs[${String(index)}]`, reason: 'must be a JSON object' })
      continue
    }
    const name = stringField(entry, 'name')
    const version = stringField(entry, 'version')
    const file = stringField(entry, 'file')
    const safe = file === undefined ? undefined : relativePath(file)
    const integrity = stringField(entry, 'integrity')
    if (name === undefined || version === undefined || safe === undefined || integrity === undefined) {
      problems.push({
        kind: 'unproven', name: `tarballs[${String(index)}]`,
        reason: 'must name a package, its version, a file relative to the package, and an integrity',
      })
      continue
    }
    if (!/^sha512-[A-Za-z0-9+/=]+$/u.test(integrity)) {
      problems.push({ kind: 'unproven', name: safe, reason: 'the recorded tarball integrity is not a sha512 digest' })
      continue
    }
    tarballs.push({ name, version, file: safe, integrity })
  }
  return tarballs
}

/**
 * Read the lockfile a record names and prove it is the recorded one.
 * @param files - the package's files.
 * @param record - the parsed closure record.
 * @param problems - the accumulated problems to extend.
 * @returns the parsed lockfile, or undefined when it cannot be verified.
 */
function readLockfile(files: BundleFiles, record: ClosureRecord, problems: PreparedBundleProblem[]): Record<string, unknown> | undefined {
  const lockfile = record.lockfile
  if (lockfile === undefined) return undefined
  const bytes = files.read(lockfile.path)
  if (bytes === undefined) {
    problems.push({ kind: 'unproven', name: lockfile.path, reason: 'the package does not carry the recorded lockfile' })
    return undefined
  }
  if (bytes.byteLength > MAX_LOCKFILE_BYTES) {
    problems.push({ kind: 'unproven', name: lockfile.path, reason: `the lockfile is larger than ${String(MAX_LOCKFILE_BYTES)} bytes` })
    return undefined
  }
  if (digestOf(bytes) !== lockfile.sha256) {
    problems.push({ kind: 'unproven', name: lockfile.path, reason: 'the lockfile does not match the sha256 the record names' })
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseYaml(new TextDecoder().decode(bytes))
  } catch (error) {
    problems.push({ kind: 'unproven', name: lockfile.path, reason: `the lockfile is not readable YAML: ${messageOf(error)}` })
    return undefined
  }
  const lock = recordOf(parsed)
  if (lock === undefined) {
    problems.push({ kind: 'unproven', name: lockfile.path, reason: 'the lockfile is not a YAML mapping' })
    return undefined
  }
  return lock
}

/** One package entry pnpm's lockfile records. */
interface LockPackage {
  readonly name: string
  readonly version: string
  readonly requiresBuild: boolean
  readonly integrity: string | undefined
  readonly os: readonly string[]
  readonly cpu: readonly string[]
  readonly dependencies: Record<string, unknown>
  readonly optionalDependencies: Record<string, unknown>
}

/** One package the lockfile resolves for the prepared package. */
interface ResolvedPackage extends LockPackage {
  readonly required: boolean
}

/** What walking pnpm's lockfile resolved for the prepared package. */
interface LockResolution {
  readonly packages: readonly ResolvedPackage[]
  /** Identities the host platform excluded, which the record is not required to list. */
  readonly skipped: ReadonlySet<string>
  readonly problems: readonly PreparedBundleProblem[]
}

/**
 * Walk the lockfile from the package's own importer through every dependency, recording the exact versions and
 * requiredness, and refuse versions and platforms this format cannot verify.
 * @param lock - the parsed lockfile.
 * @param manifest - the package manifest, whose declared dependencies the lockfile must record.
 * @param hostProvided - dependencies the record says the profile or installation supplies.
 * @returns the resolved closure with its problems.
 */
function resolveLockClosure(
  lock: Record<string, unknown>, manifest: object, hostProvided: ReadonlySet<string>,
): LockResolution {
  const problems: PreparedBundleProblem[] = []
  const skipped = new Set<string>()
  const importers = recordOf(lock.importers)
  const importer = importers === undefined ? undefined : recordOf(importers['.'])
  if (importer === undefined) {
    return {
      packages: [], skipped,
      problems: [{ kind: 'unproven', name: 'pnpm-lock.yaml', reason: 'the lockfile records no importer for the package itself' }],
    }
  }
  const packages = lockPackagesOf(lock)
  const root = {
    dependencies: recordOf(importer.dependencies) ?? {},
    optionalDependencies: recordOf(importer.optionalDependencies) ?? {},
  }
  for (const name of requiredDependencyNames(manifest)) {
    if (hostProvided.has(name)) continue
    if (!Object.hasOwn(root.dependencies, name) && !Object.hasOwn(root.optionalDependencies, name)) {
      problems.push({ kind: 'unproven', name, reason: 'the lockfile does not record this declared dependency' })
    }
  }
  const pending: { name: string; version: string; required: boolean }[] = []
  const enqueue = (dependencies: Record<string, unknown>, required: boolean): void => {
    for (const [name, value] of Object.entries(dependencies)) {
      if (hostProvided.has(name)) continue
      const version = dependencyVersion(value)
      if (version === undefined) {
        if (!required) continue
        problems.push({ kind: 'unproven', name, reason: 'the lockfile records no resolved version' })
        continue
      }
      if (NON_REGISTRY_VERSION.test(version)) {
        problems.push({ kind: 'unsupported', name, reason: `the lockfile resolves ${version}, which ${PREPARED_FORMAT} does not support` })
        continue
      }
      pending.push({ name, version, required })
    }
  }
  enqueue(root.dependencies, true)
  enqueue(root.optionalDependencies, false)
  if (pending.length > MAX_CLOSURE_PACKAGES) {
    return {
      packages: [], skipped,
      problems: [{ kind: 'unsupported', name: 'pnpm-lock.yaml', reason: `the closure has more than ${String(MAX_CLOSURE_PACKAGES)} packages` }],
    }
  }
  const resolved = new Map<string, ResolvedPackage>()
  const visited = new Map<string, boolean>()
  for (let index = 0; index < pending.length; index++) {
    if (index >= MAX_CLOSURE_PACKAGES) {
      problems.push({ kind: 'unsupported', name: 'pnpm-lock.yaml', reason: `the closure has more than ${String(MAX_CLOSURE_PACKAGES)} packages` })
      break
    }
    const item = pending[index]
    if (item === undefined) break
    const identity = identityOf(item.name, item.version)
    const seen = visited.get(identity)
    if (seen === true) continue
    if (seen === false && !item.required) continue
    const required = item.required
    visited.set(identity, required)
    const pkg = packages.get(identity)
    if (pkg === undefined) {
      problems.push({ kind: 'missing', name: identity, reason: 'the lockfile records no installed copy' })
      continue
    }
    if (!platformAllowed(pkg.os, process.platform) || !platformAllowed(pkg.cpu, process.arch)) {
      if (required) {
        problems.push({
          kind: 'unsupported', name: identity,
          reason: `requires os ${pkg.os.join(',') || 'any'} and cpu ${pkg.cpu.join(',') || 'any'}; this host is ${process.platform}/${process.arch}`,
        })
      }
      skipped.add(identity)
      continue
    }
    resolved.set(identity, { ...pkg, required })
    enqueue(pkg.dependencies, required)
    enqueue(pkg.optionalDependencies, false)
  }
  return { packages: [...resolved.values()], skipped, problems }
}

/**
 * Compare the closure the lockfile resolves with the record and the files beside the package.
 * @param files - the package's files.
 * @param record - the parsed closure record.
 * @param resolution - the lockfile's resolved closure.
 * @param peers - the package's peer dependencies.
 * @param hostProvided - dependencies the record says the profile or installation supplies.
 * @returns every gap or unsupported item found.
 */
function compareClosure(
  files: BundleFiles, manifest: object, record: ClosureRecord, resolution: LockResolution,
  peers: readonly PreparedBundlePeer[], hostProvided: ReadonlySet<string>,
): PreparedBundleProblem[] {
  const problems: PreparedBundleProblem[] = []
  const recorded = new Map<string, RecordedPackage>()
  for (const pkg of record.packages) {
    const identity = identityOf(pkg.name, pkg.version)
    if (recorded.has(identity)) {
      problems.push({ kind: 'unproven', name: identity, reason: 'the record lists this dependency twice' })
      continue
    }
    recorded.set(identity, pkg)
  }
  const resolvedIdentities = new Set(resolution.packages.map(pkg => identityOf(pkg.name, pkg.version)))
  for (const pkg of resolution.packages) {
    const identity = identityOf(pkg.name, pkg.version)
    const entry = recorded.get(identity)
    if (entry === undefined) {
      problems.push({ kind: 'missing', name: identity, reason: 'the lockfile resolves this dependency, but the record does not list it' })
      continue
    }
    if (entry.optional && pkg.required) {
      problems.push({ kind: 'missing', name: identity, reason: 'the record marks a required dependency optional' })
    }
    const installedBytes = files.read(`${entry.path}/package.json`)
    if (installedBytes === undefined) {
      problems.push({ kind: 'missing', name: identity, reason: `the package does not carry the installed copy at ${entry.path}` })
      continue
    }
    const installed = decodeManifest(installedBytes, `${entry.path}/package.json`)
    if (!installed.ok || stringField(installed.manifest, 'name') !== pkg.name || stringField(installed.manifest, 'version') !== pkg.version) {
      problems.push({ kind: 'missing', name: identity, reason: `the installed copy at ${entry.path} does not name ${identity}` })
    }
    if (pkg.integrity !== undefined && entry.integrity === undefined) {
      problems.push({ kind: 'unproven', name: identity, reason: 'the record records no lockfile integrity' })
    } else if (pkg.integrity !== undefined && entry.integrity !== undefined && pkg.integrity !== entry.integrity) {
      problems.push({ kind: 'unproven', name: identity, reason: 'the record integrity does not match the lockfile' })
    }
  }
  for (const identity of recorded.keys()) {
    if (!resolvedIdentities.has(identity) && !resolution.skipped.has(identity)) {
      problems.push({ kind: 'unsupported', name: identity, reason: 'the record lists a dependency the lockfile does not resolve' })
    }
  }
  problems.push(...compareSets(
    'installScripts',
    resolution.packages.filter(pkg => pkg.requiresBuild).map(pkg => identityOf(pkg.name, pkg.version)),
    record.installScripts,
  ))
  problems.push(...compareSets(
    'native',
    resolution.packages.filter(pkg => pkg.os.length > 0 || pkg.cpu.length > 0).map(pkg => identityOf(pkg.name, pkg.version)),
    record.native,
  ))
  const declared = new Set([...declaredDependencyNames(manifest), ...peers.map(peer => peer.name)])
  for (const provided of hostProvided) {
    if (!declared.has(provided)) {
      problems.push({ kind: 'unsupported', name: provided, reason: 'is listed as host-provided but the package manifest declares no such dependency' })
    }
    if (resolution.packages.some(pkg => pkg.name === provided)) {
      problems.push({ kind: 'unsupported', name: provided, reason: 'is listed as host-provided but the lockfile resolves it' })
    }
  }
  for (const peer of peers) {
    if (peer.optional || hostProvided.has(peer.name)) continue
    if (!resolution.packages.some(pkg => pkg.name === peer.name)) {
      problems.push({
        kind: 'unsupported', name: peer.name,
        reason: `peer dependency ${peer.name}@${peer.range} is neither host-provided nor part of the closure; ${PREPARED_FORMAT} cannot prove peer dependencies`,
      })
    }
  }
  return problems
}

/**
 * Compare a derived closure set with the record's declaration.
 * @param field - the record field compared.
 * @param derived - what the lockfile resolves.
 * @param declared - what the record declares.
 * @returns one problem per undeclared or over-declared identity.
 */
function compareSets(field: 'installScripts' | 'native', derived: readonly string[], declared: readonly string[]): PreparedBundleProblem[] {
  const values = new Set(derived)
  const declaredSet = new Set(declared)
  const problems: PreparedBundleProblem[] = []
  for (const identity of values) {
    if (!declaredSet.has(identity)) {
      problems.push({ kind: 'unproven', name: identity, reason: `the lockfile records this package in ${field}, but the record does not declare it` })
    }
  }
  for (const identity of declaredSet) {
    if (!values.has(identity)) {
      problems.push({ kind: 'unproven', name: identity, reason: `the record declares this package in ${field}, but the lockfile does not record it` })
    }
  }
  return problems
}

/**
 * Read every package pnpm's lockfile records, keyed by `name@version`.
 * @param lock - the parsed lockfile.
 * @returns the recorded packages.
 */
function lockPackagesOf(lock: Record<string, unknown>): Map<string, LockPackage> {
  const packages = new Map<string, LockPackage>()
  for (const [key, value] of Object.entries(recordOf(lock.packages) ?? {})) {
    const identity = parseLockKey(key)
    const entry = recordOf(value)
    if (identity === undefined || entry === undefined) continue
    packages.set(identityOf(identity.name, identity.version), {
      ...identity,
      requiresBuild: entry.requiresBuild === true,
      integrity: stringField(recordOf(entry.resolution) ?? {}, 'integrity'),
      os: stringArrayOf(entry.os),
      cpu: stringArrayOf(entry.cpu),
      dependencies: recordOf(entry.dependencies) ?? {},
      optionalDependencies: recordOf(entry.optionalDependencies) ?? {},
    })
  }
  for (const [key, value] of Object.entries(recordOf(lock.snapshots) ?? {})) {
    const identity = parseLockKey(key)
    const entry = recordOf(value)
    if (identity === undefined || entry === undefined) continue
    const identityKey = identityOf(identity.name, identity.version)
    const existing = packages.get(identityKey)
    packages.set(identityKey, {
      ...existing ?? {
        ...identity, requiresBuild: false, integrity: undefined, os: [], cpu: [],
        dependencies: {}, optionalDependencies: {},
      },
      dependencies: recordOf(entry.dependencies) ?? {},
      optionalDependencies: recordOf(entry.optionalDependencies) ?? {},
    })
  }
  return packages
}

/**
 * Split a pnpm lockfile key into its package identity, dropping pnpm's peer-resolution suffix.
 * @param key - a `packages` or `snapshots` key, in pnpm v6 or v9 form.
 * @returns the package name and version, or undefined for a key that names no registry package.
 */
function parseLockKey(key: string): { name: string; version: string } | undefined {
  const bare = key.startsWith('/') ? key.slice(1) : key
  if (/^(?:file|link|workspace|git|https?):/iu.test(bare)) return undefined
  const withoutPeers = bare.split('(')[0] ?? bare
  // pnpm v6 keys separate the name and version with `/`; v9 keys use `@`. A scoped name contains both, so the
  // version decides which split is the identity.
  const candidates: { name: string; version: string }[] = []
  const slash = withoutPeers.lastIndexOf('/')
  if (slash > 0) candidates.push({ name: withoutPeers.slice(0, slash), version: withoutPeers.slice(slash + 1) })
  const at = withoutPeers.lastIndexOf('@')
  if (at > 0) candidates.push({ name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) })
  for (const candidate of candidates) {
    const version = candidate.version.split('_')[0] ?? candidate.version
    if (candidate.name !== '' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) return { name: candidate.name, version }
  }
  return undefined
}

/**
 * @param value - one lockfile dependency value.
 * @returns the resolved version pnpm recorded, in v6 string or v9 object form.
 */
function dependencyVersion(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const entry = recordOf(value)
  return entry === undefined ? undefined : stringField(entry, 'version')
}

/**
 * @param values - a package's `os` or `cpu` constraint.
 * @param actual - the running platform or architecture.
 * @returns whether the constraint admits the host; an empty list admits every host.
 */
function platformAllowed(values: readonly string[], actual: string): boolean {
  if (values.length === 0) return true
  if (values.includes(actual)) return true
  const negated = values.filter(value => value.startsWith('!')).map(value => value.slice(1))
  const allowed = values.filter(value => !value.startsWith('!'))
  return !negated.includes(actual) && allowed.length === 0
}

/**
 * @param manifest - a package manifest.
 * @returns the runtime dependency names its `dependencies` field declares; optional dependencies may be skipped.
 */
function requiredDependencyNames(manifest: object): readonly string[] {
  return Object.keys(recordOf(field(manifest, 'dependencies')) ?? {})
}

/**
 * @param manifest - a package manifest.
 * @returns the runtime dependency names its `dependencies` and `optionalDependencies` declare.
 */
function declaredDependencyNames(manifest: object): readonly string[] {
  const dependencies = recordOf(field(manifest, 'dependencies')) ?? {}
  const optional = recordOf(field(manifest, 'optionalDependencies')) ?? {}
  return [...new Set([...Object.keys(dependencies), ...Object.keys(optional)])]
}

/**
 * @param manifest - a package manifest.
 * @returns the peer dependencies it declares, with whether `peerDependenciesMeta` marks each optional.
 */
function peerDependencies(manifest: object): readonly PreparedBundlePeer[] {
  const peers = recordOf(field(manifest, 'peerDependencies')) ?? {}
  const meta = recordOf(field(manifest, 'peerDependenciesMeta')) ?? {}
  return Object.entries(peers).flatMap(([name, range]) => typeof range !== 'string'
    ? []
    : [{ name, range, optional: (recordOf(meta[name]) ?? {}).optional === true }])
}

/**
 * @param value - a candidate record field.
 * @param label - the record field name, for the problem.
 * @param problems - the accumulated problems to extend.
 * @returns the string list, or undefined when the field is malformed or absent.
 */
function readStrings(
  value: unknown, label: string, problems: PreparedBundleProblem[],
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: `${label} must be an array of strings` })
    return undefined
  }
  const strings = value.filter((item): item is string => typeof item === 'string')
  if (strings.length !== value.length) {
    problems.push({ kind: 'unproven', name: RECORD_FILE, reason: `${label} must be an array of strings` })
    return undefined
  }
  return strings
}

/**
 * @param value - a candidate lockfile field.
 * @returns the string list, or an empty list when the field is absent or malformed.
 */
function stringArrayOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return []
    strings.push(item)
  }
  return strings
}

/**
 * @param value - a record's relative path.
 * @returns the normalized `/`-separated path, or undefined when it is absolute or escapes the package.
 */
function relativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

/**
 * @param name - package name.
 * @param version - package version.
 * @returns the key both the lockfile and the record are compared by.
 */
function identityOf(name: string, version: string): string {
  return `${name}@${version}`
}

/**
 * @param contentDigest - digest of every file the bundle carries.
 * @param manifestBytes - the package manifest bytes.
 * @param recordBytes - the closure record bytes, when one exists.
 * @returns a digest that changes when any bundle file or the record changes.
 */
function fingerprintOf(contentDigest: string, manifestBytes: Uint8Array, recordBytes: Uint8Array | undefined): string {
  const hash = createHash('sha256')
    .update(FINGERPRINT_DOMAIN)
    .update(new Uint8Array([0]))
    .update(contentDigest)
    .update(new Uint8Array([0]))
    .update(manifestBytes)
  if (recordBytes !== undefined) hash.update(new Uint8Array([0])).update(recordBytes)
  return hash.digest('hex')
}

/**
 * @param bytes - one file's bytes.
 * @returns its SHA-256 as lower-case hex.
 */
function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param bytes - UTF-8 JSON.
 * @returns the parsed document; malformed input reads as undefined.
 */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined /* malformed JSON proves nothing */
  }
}

/**
 * @param value - a candidate manifest field.
 * @param name - the field to read.
 * @returns the string value, or undefined when the field is absent or not a string.
 */
function stringField(value: object, name: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[name]
  return typeof candidate === 'string' ? candidate : undefined
}

/** The manifest field an object holds, without assuming an index signature. */
function field(value: object, name: string): unknown {
  return (value as Record<string, unknown>)[name]
}

/**
 * @param value - a parsed document.
 * @returns the value as a string-keyed record, or undefined for anything else.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Index an uncompressed ustar archive by entry path, keeping the data blocks that name files.
 * @param bytes - the whole archive.
 * @returns the entries read before the end block or a malformed header.
 */
function indexTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>()
  let offset = 0
  for (let entry = 0; entry < MAX_ARCHIVE_ENTRIES; entry++) {
    if (offset + TAR_BLOCK > bytes.length) return entries
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    // A zero block marks the end of the archive.
    if (header.every(byte => byte === 0)) return entries
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const size = tarNumber(header, 124, 12)
    if (size === undefined) return entries
    const data = offset + TAR_BLOCK
    if (data + size > bytes.length) return entries
    entries.set(prefix === '' ? name : `${prefix}/${name}`, bytes.subarray(data, data + size))
    offset = data + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return entries
}

/**
 * @param directory - package directory.
 * @returns the decoded `package.json`.
 */
function directoryManifest(directory: string): LocalBundleManifest {
  const stats = statSync(directory)
  if (!stats.isDirectory()) return { ok: false, problem: 'not-a-package', reason: 'the path is not a package directory' }
  const bytes = readFileSync(join(directory, 'package.json'))
  return decodeManifest(bytes, 'package.json')
}

/**
 * @param archive - gzip-compressed tarball.
 * @returns the decoded `package/package.json`.
 */
function archiveManifest(archive: string): LocalBundleManifest {
  const stats = statSync(archive)
  if (!stats.isFile()) return { ok: false, problem: 'not-a-package', reason: 'the tarball is not a file' }
  if (stats.size > MAX_ARCHIVE_BYTES) {
    return { ok: false, problem: 'not-a-package', reason: `the tarball is larger than ${String(MAX_ARCHIVE_BYTES)} bytes` }
  }
  const bytes = gunzipSync(readFileSync(archive), { maxOutputLength: MAX_ARCHIVE_BYTES })
  const entry = findManifestEntry(bytes)
  if (entry === undefined) return { ok: false, problem: 'not-a-package', reason: 'the tarball carries no package/package.json' }
  return decodeManifest(entry, 'package/package.json')
}

/**
 * Parse one manifest document, bounded to what an inspection reads.
 * @param bytes - UTF-8 JSON bytes.
 * @param name - file name for the refusal.
 * @returns the decoded manifest object.
 */
function decodeManifest(bytes: Uint8Array, name: string): LocalBundleManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    return { ok: false, problem: 'not-a-package', reason: `${name} is larger than ${String(MAX_MANIFEST_BYTES)} bytes` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    return { ok: false, problem: 'not-a-package', reason: `${name} is not readable JSON: ${messageOf(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: 'not-a-package', reason: `${name} is not a package manifest` }
  }
  return { ok: true, manifest: parsed }
}

/**
 * Find the manifest entry in an uncompressed ustar archive.
 * @param bytes - the whole archive.
 * @returns the manifest bytes, or undefined when no entry names one.
 */
function findManifestEntry(bytes: Uint8Array): Uint8Array | undefined {
  let offset = 0
  for (let entry = 0; entry < MAX_ARCHIVE_ENTRIES; entry++) {
    if (offset + TAR_BLOCK > bytes.length) return undefined
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    // A zero block marks the end of the archive.
    if (header.every(byte => byte === 0)) return undefined
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const size = tarNumber(header, 124, 12)
    if (size === undefined) return undefined
    const data = offset + TAR_BLOCK
    if (data + size > bytes.length) return undefined
    // npm's archives carry the manifest under `package/`; a root-level manifest is accepted too.
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (path === 'package/package.json' || path === 'package.json') return bytes.subarray(data, data + size)
    offset = data + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return undefined
}

/**
 * @param block - one tar header.
 * @param start - field offset.
 * @param length - field width.
 * @returns the NUL-terminated text field.
 */
function tarText(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end))
}

/**
 * @param block - one tar header.
 * @param start - field offset.
 * @param length - field width.
 * @returns the octal field value, or undefined when the archive declares none.
 */
function tarNumber(block: Uint8Array, start: number, length: number): number | undefined {
  const text = tarText(block, start, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) return undefined
  return Number.parseInt(text, 8)
}

/**
 * @param error - thrown value.
 * @returns a single-line description.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
