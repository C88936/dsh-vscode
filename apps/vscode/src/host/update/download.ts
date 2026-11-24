/**
 * Download one published VSIX into the extension's global storage and verify it before publishing it there.
 *
 * A failure never leaves a usable artifact behind: the bytes are written to a staged file, the size and SHA-256 are
 * checked against the feed while they stream, and only a verified file is renamed to the version-named path the
 * install reads. Every failure removes the staged file, so a later attempt starts from an absent artifact instead of
 * a truncated one. The request refuses redirects and re-applies the feed's address rule, so neither a redirect nor a
 * hand-built manifest can move the download to an address the feed did not publish.
 * @module @deepseek-ai/dsh-vscode/host/update/download
 */
import { createHash } from 'node:crypto'
import { mkdir, open as openFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describeUpdateError } from './errors.ts'
import { updateUrlError, type UpdateManifest } from './manifest.ts'
import { isSharePackage, readUpdateShare } from './share.ts'

/** Largest VSIX this extension downloads, in bytes: 1 GiB, about four times the current standalone package. */
const MAX_VSIX_BYTES = 1024 * 1024 * 1024

/** Why one download stopped. */
export type DownloadFailureCode =
  | 'url'
  | 'too-large'
  | 'cancelled'
  | 'request-failed'
  | 'http-status'
  | 'no-body'
  | 'size-mismatch'
  | 'digest-mismatch'
  | 'write-failed'

/** One stopped download. */
export interface DownloadFailure {
  /** Stable failure discriminant. */
  readonly code: DownloadFailureCode
  /** Readable reason, naming the values that disagreed where one did. */
  readonly detail: string
}

/** A verified VSIX inside the update directory. */
export interface DownloadedUpdate {
  /** Version the file was published for. */
  readonly version: string
  /** Absolute path of the verified file. */
  readonly path: string
  /** Measured SHA-256, equal to the feed's digest. */
  readonly sha256: string
  /** Measured size, equal to the feed's size. */
  readonly size: number
}

/** Outcome of one download. */
export type DownloadResult =
  | { readonly ok: true; readonly downloaded: DownloadedUpdate }
  | { readonly ok: false; readonly failure: DownloadFailure }

/** The file operations one download performs on the staged file. */
export interface DownloadFile {
  /**
   * Append one chunk.
   * @param chunk - bytes to write.
   * @returns settles when the bytes are written; a rejection stops the download.
   */
  write(chunk: Uint8Array): Promise<unknown>
  /**
   * @returns settles when the file is closed; a rejection does not change the reported outcome.
   */
  close(): Promise<void>
}

/**
 * Open a file the caller owns.
 * @param path - absolute path inside the update directory.
 * @param flags - `wx`, which refuses to reuse an existing file.
 * @param mode - owner-only permissions for the created file.
 * @returns the open file.
 */
export type OpenDownloadFile = (path: string, flags: 'wx', mode: number) => Promise<DownloadFile>

/** Inputs for one download. */
export interface DownloadUpdateOptions {
  /** The validated feed naming the address, size, and digest. */
  readonly manifest: UpdateManifest
  /** Directory that receives the verified file; the extension passes its global storage. */
  readonly directory: string
  /** Cancels the download; the staged file is removed before this settles. */
  readonly signal?: AbortSignal
  /** Larger declared sizes are refused before any request is sent; absent uses the 1 GiB cap. */
  readonly maxBytes?: number
  /** Network implementation; absent uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** File opener; absent opens `wx` with owner-only permissions. */
  readonly openFile?: OpenDownloadFile
}

/**
 * Download, verify, and publish one VSIX.
 *
 * Concurrent calls for the same version share the staged path, so callers run one download at a time; the coordinator
 * owns that serialization.
 * @param options - the feed entry, the destination directory, and optional cancellation and transport.
 * @returns the verified file, or the reason the download stopped and which staged artifacts remain (none).
 */
export async function downloadUpdate(options: DownloadUpdateOptions): Promise<DownloadResult> {
  const { manifest, signal } = options
  const maxBytes = options.maxBytes ?? MAX_VSIX_BYTES
  const send = options.fetch ?? globalThis.fetch
  const create: OpenDownloadFile = options.openFile ?? (async (path, flags, mode) => await openFile(path, flags, mode))
  // Read through a function so the first check does not narrow the signal for the rest of the download.
  const aborted = (): boolean => signal?.aborted === true

  const addressProblem = manifest.shareDirectory === undefined ? updateUrlError(manifest.url)
    : isSharePackage(manifest.url) ? undefined : 'expected a DSH VSIX file name in the configured share directory'
  if (addressProblem !== undefined) return { ok: false, failure: { code: 'url', detail: addressProblem } }
  if (manifest.size > maxBytes) {
    return {
      ok: false,
      failure: {
        code: 'too-large',
        detail: `the feed declares ${String(manifest.size)} bytes, above the ${String(maxBytes)}-byte download cap`,
      },
    }
  }
  if (aborted()) return { ok: false, failure: cancelFailure('the download was cancelled before it started') }

  try {
    await mkdir(options.directory, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      failure: { code: 'write-failed', detail: `the update directory could not be created: ${describeUpdateError(error)}` },
    }
  }
  const staged = join(options.directory, `.dsh-vscode-${manifest.version}.vsix.partial`)
  const published = join(options.directory, `dsh-vscode-${manifest.version}.vsix`)
  await discard(staged)

  let response: Response
  try {
    response = manifest.shareDirectory === undefined
      ? await send(manifest.url, { redirect: 'error', cache: 'no-store', signal: signal ?? null })
      : readUpdateShare(manifest.shareDirectory, manifest.url, signal)
  } catch (error) {
    if (aborted()) return { ok: false, failure: cancelFailure('the download was cancelled while connecting') }
    return {
      ok: false,
      failure: { code: 'request-failed', detail: `the VSIX request failed: ${describeUpdateError(error)}` },
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(countCancelledBody)
    return {
      ok: false,
      failure: { code: 'http-status', detail: `the VSIX request answered HTTP ${String(response.status)}` },
    }
  }
  if (response.body === null) {
    return { ok: false, failure: { code: 'no-body', detail: 'the VSIX response carried no body' } }
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) !== manifest.size) {
    await response.body.cancel().catch(countCancelledBody)
    return {
      ok: false,
      failure: {
        code: 'size-mismatch',
        detail: `the response declares ${declaredLength} bytes; the feed declares ${String(manifest.size)}`,
      },
    }
  }

  const reader = response.body.getReader()
  let handle: DownloadFile | undefined
  let failure: DownloadFailure | undefined
  let sha256 = ''
  try {
    handle = await create(staged, 'wx', 0o600)
    const hash = createHash('sha256')
    let received = 0
    while (failure === undefined) {
      if (aborted()) {
        failure = cancelFailure('the download was cancelled')
        break
      }
      const next = await reader.read()
      if (next.done === true) break
      received += next.value.byteLength
      if (received > maxBytes) {
        failure = {
          code: 'too-large',
          detail: `the response passed the ${String(maxBytes)}-byte download cap`,
        }
        break
      }
      if (received > manifest.size) {
        failure = {
          code: 'size-mismatch',
          detail: `the response passed the feed's ${String(manifest.size)} bytes`,
        }
        break
      }
      hash.update(next.value)
      await handle.write(next.value)
    }
    if (failure === undefined) {
      if (received !== manifest.size) {
        failure = {
          code: 'size-mismatch',
          detail: `the response carried ${String(received)} bytes; the feed declares ${String(manifest.size)}`,
        }
      } else {
        const digest = hash.digest('hex')
        if (digest !== manifest.sha256) {
          failure = {
            code: 'digest-mismatch',
            detail: `the feed declares SHA-256 ${manifest.sha256}; the response hashed to ${digest}`,
          }
        } else {
          sha256 = digest
        }
      }
    }
  } catch (error) {
    failure = aborted()
      ? cancelFailure('the download was cancelled while streaming')
      : { code: 'write-failed', detail: `the VSIX could not be written: ${describeUpdateError(error)}` }
  } finally {
    if (failure !== undefined) await reader.cancel().catch(countCancelledBody)
    if (handle !== undefined) await handle.close().catch(countCleanupFailure)
  }

  if (failure !== undefined) {
    await discard(staged)
    return { ok: false, failure }
  }
  try {
    await rename(staged, published)
  } catch (error) {
    await discard(staged)
    return {
      ok: false,
      failure: {
        code: 'write-failed',
        detail: `the verified VSIX could not be published as ${published}: ${describeUpdateError(error)}`,
      },
    }
  }
  return { ok: true, downloaded: { version: manifest.version, path: published, sha256, size: manifest.size } }
}

/**
 * @param detail - readable reason.
 * @returns the cancelled failure.
 */
function cancelFailure(detail: string): DownloadFailure {
  return { code: 'cancelled', detail }
}

/**
 * Remove one staged file.
 *
 * An absent file needs no removal; any other failure leaves the version-named path unpublished, which is the
 * guarantee this function provides, so the download's own failure stays the reported one.
 * @param path - staged file to remove.
 */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    countCleanupFailure(error)
  }
}

/**
 * @param _error - a cleanup failure that does not change the reported outcome.
 */
function countCleanupFailure(_error: unknown): void {}

/**
 * @param _error - a body cancellation failure after the response is already refused.
 */
function countCancelledBody(_error: unknown): void {}
