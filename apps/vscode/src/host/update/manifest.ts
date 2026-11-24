/**
 * The `dsh-vscode-update/v1` feed the intranet update check reads.
 *
 * The feed is external input, so every field is validated before anything is downloaded and a feed that breaks one
 * rule is rejected whole: a partial manifest would let the extension act on values the publisher did not state.
 * The template trusts the HTTPS origin that serves the feed and the artifact; the SHA-256 detects a corrupted or
 * replaced download, not a hostile publisher.
 * @module @deepseek-ai/dsh-vscode/host/update/manifest
 */
import { valid, validRange } from 'semver'
import { isSharePackage } from './share.ts'

/** Schema marker every feed declares in `schemaVersion`. */
export const UPDATE_MANIFEST_SCHEMA = 'dsh-vscode-update/v1'

/** Longest release note a feed may carry, in characters. */
export const MAX_RELEASE_NOTES_LENGTH = 4000

/** Hosts that make plain HTTP acceptable, so a test server can serve a feed and a VSIX. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** A VS Code extension identifier: `publisher.name`, both lowercase. */
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/u

/** `universal`, or a platform and architecture pair such as `win32-x64`. */
const TARGET_PLATFORM_PATTERN = /^(?:universal|[a-z0-9]+-[a-z0-9]+)$/u

/** A lowercase SHA-256 digest. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** An ISO 8601 date-time with an explicit UTC offset or `Z`. */
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u

/**
 * Why one feed field was rejected.
 *
 * `code` is the stable discriminant; `field` names the JSON member and `detail` is the readable reason that reaches
 * the diagnostic log.
 */
export type UpdateManifestProblemCode =
  | 'not-json'
  | 'not-object'
  | 'schema-version'
  | 'extension-id'
  | 'version'
  | 'engines'
  | 'target-platform'
  | 'url'
  | 'sha256'
  | 'size'
  | 'published-at'
  | 'release-notes'

/** One rejected feed field. */
export interface UpdateManifestProblem {
  /** Stable failure discriminant. */
  readonly code: UpdateManifestProblemCode
  /** JSON member that failed validation. */
  readonly field: string
  /** Readable reason, including the rejected value. */
  readonly detail: string
}

/** A validated update feed. */
export interface UpdateManifest {
  /** Schema marker this feed declares. */
  readonly schemaVersion: typeof UPDATE_MANIFEST_SCHEMA
  /** Extension a client must be running before the feed applies, as `publisher.name`. */
  readonly extensionId: string
  /** Published version, normalized to strict semver. */
  readonly version: string
  /** VS Code versions the package supports. */
  readonly engines: {
    /** The `engines.vscode` range declared by the VSIX manifest. */
    readonly vscode: string
  }
  /** Platform the package targets: `universal`, or `<platform>-<arch>`. */
  readonly targetPlatform: string
  /** HTTPS address or, for a Windows share, the VSIX file name. */
  readonly url: string
  /** Trusted directory from application settings for a share feed. */
  readonly shareDirectory?: string
  /** Lowercase SHA-256 of the VSIX. */
  readonly sha256: string
  /** Exact VSIX size in bytes. */
  readonly size: number
  /** Publication instant, as an ISO 8601 date-time. */
  readonly publishedAt: string
  /** Publisher's human-readable notes for this version. */
  readonly releaseNotes?: string
}

/** Outcome of validating one feed document. */
export type UpdateManifestResult =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly problem: UpdateManifestProblem }

/**
 * Report why one download address cannot be used.
 *
 * A feed and a download request both apply this rule, so an address the parser accepts cannot be refused later by a
 * different check: HTTPS anywhere, plain HTTP only on loopback for a test server, and never embedded credentials.
 * @param value - absolute download URL as published.
 * @returns the reason the address cannot be used, or undefined when it may be fetched.
 */
export function updateUrlError(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return 'the download URL is empty'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return `the download URL is not a URL: ${JSON.stringify(trimmed)}`
  }
  if (parsed.username !== '' || parsed.password !== '') return 'the download URL must not embed credentials'
  if (parsed.protocol === 'https:') return undefined
  if (parsed.protocol !== 'http:') return `the download URL must use HTTPS, not ${parsed.protocol}`
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return `plain HTTP is allowed only for a loopback test server; ${parsed.hostname} is not loopback`
  }
  return undefined
}

/**
 * Validate one feed document.
 *
 * Fields are checked in feed order and the first rejection is reported, so a publisher fixes one value per attempt.
 * Unknown members are ignored: a later schema version may add them, and this one never reads them.
 * @param text - feed body as served by the release origin.
 * @param shareDirectory - configured directory for a share feed; names in that feed stay inside it.
 * @returns the validated manifest, or the rejected field and reason.
 */
export function parseUpdateManifest(text: string, shareDirectory?: string): UpdateManifestResult {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    return problem('not-json', 'feed', `the feed is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return problem('not-object', 'feed', 'the feed must be one JSON object')
  }
  const feed: Record<string, unknown> = { ...decoded }

  if (feed.schemaVersion !== UPDATE_MANIFEST_SCHEMA) {
    return problem(
      'schema-version',
      'schemaVersion',
      `expected ${JSON.stringify(UPDATE_MANIFEST_SCHEMA)}, read ${JSON.stringify(feed.schemaVersion)}`,
    )
  }

  const extensionId = feed.extensionId
  if (typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
    return problem(
      'extension-id',
      'extensionId',
      `expected a lowercase publisher.name identifier, read ${JSON.stringify(extensionId)}`,
    )
  }

  const version = typeof feed.version === 'string' ? valid(feed.version.trim()) : null
  if (version === null) {
    return problem('version', 'version', `expected a semver version, read ${JSON.stringify(feed.version)}`)
  }

  const engines = feed.engines
  const vsCodeRange = typeof engines === 'object' && engines !== null && !Array.isArray(engines)
    ? (engines as { vscode?: unknown }).vscode
    : undefined
  if (typeof vsCodeRange !== 'string' || validRange(vsCodeRange.trim()) === null) {
    return problem(
      'engines',
      'engines.vscode',
      `expected a semver range for the VS Code engine, read ${JSON.stringify(vsCodeRange)}`,
    )
  }

  const targetPlatform = feed.targetPlatform
  if (typeof targetPlatform !== 'string' || !TARGET_PLATFORM_PATTERN.test(targetPlatform)) {
    return problem(
      'target-platform',
      'targetPlatform',
      `expected "universal" or "<platform>-<arch>" such as "win32-x64", read ${JSON.stringify(targetPlatform)}`,
    )
  }

  if (typeof feed.url !== 'string') {
    return problem('url', 'url', `expected a URL string, read ${JSON.stringify(feed.url)}`)
  }
  const url = feed.url.trim()
  const urlProblem = shareDirectory === undefined ? updateUrlError(url)
    : isSharePackage(url) ? undefined : 'expected a DSH VSIX file name in the configured share directory'
  if (urlProblem !== undefined) return problem('url', 'url', urlProblem)

  const sha256 = feed.sha256
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    return problem('sha256', 'sha256', `expected 64 lowercase hexadecimal characters, read ${JSON.stringify(sha256)}`)
  }

  const size = feed.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    return problem('size', 'size', `expected a positive integer number of bytes, read ${JSON.stringify(size)}`)
  }

  const publishedAt = feed.publishedAt
  if (typeof publishedAt !== 'string' || !PUBLISHED_AT_PATTERN.test(publishedAt) || Number.isNaN(Date.parse(publishedAt))) {
    return problem('published-at', 'publishedAt', `expected an ISO 8601 date-time, read ${JSON.stringify(publishedAt)}`)
  }

  const releaseNotes = feed.releaseNotes
  if (releaseNotes !== undefined) {
    if (typeof releaseNotes !== 'string') {
      return problem('release-notes', 'releaseNotes', 'releaseNotes must be a string when present')
    }
    if (releaseNotes.length > MAX_RELEASE_NOTES_LENGTH) {
      return problem(
        'release-notes',
        'releaseNotes',
        `releaseNotes is longer than ${String(MAX_RELEASE_NOTES_LENGTH)} characters`,
      )
    }
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: UPDATE_MANIFEST_SCHEMA,
      extensionId,
      version,
      engines: { vscode: vsCodeRange.trim() },
      targetPlatform,
      url,
      ...shareDirectory === undefined ? {} : { shareDirectory },
      sha256,
      size,
      publishedAt,
      ...releaseNotes === undefined ? {} : { releaseNotes },
    },
  }
}

/**
 * @param code - stable failure discriminant. @param field - JSON member. @param detail - readable reason.
 * @returns the rejected-feed result.
 */
function problem(code: UpdateManifestProblemCode, field: string, detail: string): UpdateManifestResult {
  return { ok: false, problem: { code, field, detail } }
}
