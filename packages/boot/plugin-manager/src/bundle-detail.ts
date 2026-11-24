/**
 * Detail documents of profile bundles: an installed bundle's `meta.detail` file or README from its directory, and an
 * official bundle the installation offers, before it is installed, from the npm file CDNs at its offered version. Reads
 * keep no state; an image request resolves its bundle and document again.
 */
import semver from 'semver'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import {
  DetailFailure, detailImage, languageChain, localFiles, npmFileSourceOrder, npmFiles, readPackageDocument,
  type DetailFiles, type NpmFileSource,
} from '@deepseek-ai/dsh-plugin-detail'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { BundleDetail, BundleInfo } from './types.ts'

/** Limits and sources of bundle detail reads. */
export interface BundleDetailOptions {
  readonly profile: ProfileContext
  readonly maxDocumentBytes: number
  readonly maxImageBytes: number
  readonly npmFileSources: readonly NpmFileSource[]
  /** Deadline of one CDN request. */
  readonly timeoutMs: number
  /** The plugin manager's disposal. */
  readonly lifetime: AbortSignal
}

/**
 * What one listed bundle's detail files are, or why the bundle's detail reports no document: `none` when it is offered
 * at no published version, `unavailable` when it is offered and no npm file CDN is configured.
 */
type BundleFiles =
  | { readonly status: 'files'; readonly files: DetailFiles }
  | { readonly status: 'none' }
  | { readonly status: 'unavailable' }

/**
 * The files of a listed bundle: its directory when its files can be read, otherwise its offered npm version.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the files; `none` for a bundle offered at no published version, `unavailable` for an offered bundle when
 *   the configured source list is empty.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` when the bundle's directory cannot be resolved.
 */
function filesOf(bundle: BundleInfo, preferred: readonly string[], options: BundleDetailOptions): BundleFiles {
  if (bundle.availability !== 'missing') {
    let dir: string
    try {
      dir = resolveBundleDir('dsh', bundle.name, options.profile.installAnchor, options.profile.dir)
    } catch (error) {
      throw new RemoteError('plugin-manager/unknown-bundle', (error as Error).message, { name: bundle.name }, { cause: error })
    }
    // `listBundles()` reports the version of every bundle whose manifest it read; one without is read as unversioned.
    return { status: 'files', files: localFiles(dir, String(bundle.version)) }
  }
  const version = bundle.installTarget?.version
  if (version === undefined || semver.valid(version) !== version) return { status: 'none' }
  // The configured list, not the preferred one, decides whether this deployment reads public package files at all.
  if (options.npmFileSources.length === 0) return { status: 'unavailable' }
  const sources = npmFileSourceOrder(options.npmFileSources, preferred)
  return { status: 'files', files: npmFiles(bundle.name, version, sources, { timeoutMs: options.timeoutMs, lifetime: options.lifetime }) }
}

/** Rethrow a detail failure as the Remote error clients read. */
function remoteFailure(error: unknown): never {
  if (error instanceof DetailFailure) {
    throw new RemoteError('plugin-manager/detail-unavailable', error.message, { reason: error.reason }, { cause: error })
  }
  throw error
}

/**
 * Read a bundle's detail document in a display language.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param language - a BCP 47 language id.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the document; `none` when the bundle has neither a `meta.detail` file nor a README; `unavailable` when it is
 *   offered and the configured source list is empty.
 * @throws {RemoteError} `plugin-manager/invalid-language`, `plugin-manager/unknown-bundle`, or
 *   `plugin-manager/detail-unavailable`.
 */
export async function readBundleDocument(
  bundle: BundleInfo, language: string, preferred: readonly string[], options: BundleDetailOptions,
): Promise<BundleDetail> {
  let languages: string[]
  try {
    languages = languageChain(language)
  } catch (error) {
    throw new RemoteError('plugin-manager/invalid-language', (error as Error).message, { language }, { cause: error })
  }
  const found = filesOf(bundle, preferred, options)
  if (found.status === 'none') return { status: 'none' }
  if (found.status === 'unavailable') return { status: 'unavailable' }
  const document = await readPackageDocument(found.files, '', languages, options.maxDocumentBytes, options.lifetime).catch(remoteFailure)
  return document === undefined ? { status: 'none' } : { status: 'found', ...document }
}

/**
 * Read an image beside a bundle's detail document.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param document - the document's path inside the bundle, as {@link readBundleDocument} returned it.
 * @param destination - the image destination as the document writes it.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the bytes and media type, or undefined for a path outside the bundle, an unsupported type, a missing file,
 *   or an offered bundle whose deployment configures no npm file CDN.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` or `plugin-manager/detail-unavailable`.
 */
export async function readBundleImage(
  bundle: BundleInfo, document: string, destination: string, preferred: readonly string[], options: BundleDetailOptions,
): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  const image = detailImage(document, destination)
  if (image === undefined) return undefined
  const found = filesOf(bundle, preferred, options)
  if (found.status !== 'files') return undefined
  const bytes = await found.files.read(image.path, options.maxImageBytes, options.lifetime).catch(remoteFailure)
  return bytes === undefined ? undefined : { bytes, mediaType: image.mediaType }
}
