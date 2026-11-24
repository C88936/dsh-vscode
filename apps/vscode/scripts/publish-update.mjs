/**
 * Write or verify the intranet update feed for one packaged VSIX.
 *
 * The publisher runs this after uploading the VSIX to the intranet release origin: the upload happens first, and only
 * then does the feed name its address. Two independent records must agree before a feed is written — the release
 * record's digest and the digest measured from the file the feed will point at — so a feed cannot describe bytes the
 * publisher did not build. Nothing here uploads, authenticates, or deletes: a mismatch fails the command and leaves
 * both files untouched.
 *
 * Usage:
 *   node scripts/publish-update.mjs (--base-url <directory URL> | --windows-share) [--vsix <path>] [--release <path>]
 *                                   [--manifest <path>] [--out <path>] [--notes <text>] [--extension-id <id>]
 *   node scripts/publish-update.mjs --verify [--vsix <path>] [--release <path>] [--manifest <path>]
 *                                   [--out <path>] [--base-url <directory URL>]
 *
 * `--base-url` is the directory URL that serves the VSIX; the feed's download address is that directory plus the
 * VSIX file name. `--out` defaults to `release-feed.json` beside the VSIX.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { valid } from 'semver'
import { isSharePackage } from '../src/host/update/share.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const schema = 'dsh-vscode-update/v1'
const args = process.argv.slice(2)

/** A failure the operator can act on: printed without a stack trace and reported through the exit code. */
class PublishError extends Error {}

/**
 * Read one valued option.
 * @param {string} name - option name including the leading dashes.
 * @param {string} fallback - value used when the option is absent.
 * @returns {string} the configured value.
 */
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new PublishError(`dsh: ${name} needs a value`)
  return value
}

/**
 * Measure one file by streaming it, so a release-sized VSIX is never held in memory.
 * @param {string} path - file to measure.
 * @returns {Promise<{ sha256: string, size: number }>} the digest and byte count.
 */
async function digestFile(path) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha256: hash.digest('hex'), size }
}

/**
 * Report why one download address cannot be published.
 *
 * The extension applies the same rule to the feed it reads: HTTPS anywhere, plain HTTP only on loopback so a test
 * server can serve a feed, and no embedded credentials.
 * @param {string} value - absolute download URL.
 * @returns {string | undefined} the reason, or undefined when the address is acceptable.
 */
function urlProblem(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return `the download URL is not a URL: ${JSON.stringify(value)}`
  }
  if (parsed.username !== '' || parsed.password !== '') return 'the download URL must not embed credentials'
  if (parsed.protocol === 'https:') return undefined
  if (parsed.protocol !== 'http:') return `the download URL must use HTTPS, not ${parsed.protocol}`
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (!loopback.has(parsed.hostname)) {
    return `plain HTTP is allowed only for a loopback test server; ${parsed.hostname} is not loopback`
  }
  return undefined
}

/**
 * @param {string} baseUrl - directory URL serving the VSIX.
 * @param {string} fileName - VSIX file name.
 * @returns {string} the download address the feed publishes.
 */
function downloadUrl(baseUrl, fileName) {
  if (baseUrl.trim() === '') throw new PublishError('dsh: --base-url is required to write or check a download address')
  const directory = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  let composed
  try {
    composed = new URL(fileName, directory).toString()
  } catch {
    throw new PublishError(`dsh: --base-url is not a URL: ${JSON.stringify(baseUrl)}`)
  }
  const problem = urlProblem(composed)
  if (problem !== undefined) throw new PublishError(`dsh: ${problem} (${composed})`)
  return composed
}

/**
 * @param {string} message - failure the operator can act on.
 * @returns {never} never returns.
 */
function fail(message) {
  throw new PublishError(message)
}

/**
 * Build the feed for the measured VSIX.
 * @param {object} input - validated inputs.
 * @returns {object} the `dsh-vscode-update/v1` feed.
 */
function buildFeed(input) {
  return {
    schemaVersion: schema,
    extensionId: input.extensionId,
    version: input.version,
    engines: { vscode: input.vscodeRange },
    targetPlatform: input.targetPlatform,
    url: input.url,
    sha256: input.sha256,
    size: input.size,
    publishedAt: new Date().toISOString(),
    ...input.notes === '' ? {} : { releaseNotes: input.notes },
  }
}

/**
 * Compare an existing feed with the measured VSIX.
 * @param {object} feed - parsed feed document.
 * @param {object} expected - facts the VSIX establishes.
 * @returns {string[]} one line per disagreement; empty when the feed matches.
 */
function feedDisagreements(feed, expected) {
  const problems = []
  if (feed.schemaVersion !== schema) problems.push(`schemaVersion is ${JSON.stringify(feed.schemaVersion)}; expected ${schema}`)
  if (feed.extensionId !== expected.extensionId) {
    problems.push(`extensionId is ${JSON.stringify(feed.extensionId)}; expected ${expected.extensionId}`)
  }
  if (feed.version !== expected.version) problems.push(`version is ${JSON.stringify(feed.version)}; expected ${expected.version}`)
  if (feed.sha256 !== expected.sha256) problems.push(`sha256 is ${JSON.stringify(feed.sha256)}; the VSIX hashes to ${expected.sha256}`)
  if (feed.size !== expected.size) problems.push(`size is ${JSON.stringify(feed.size)}; the VSIX has ${String(expected.size)} bytes`)
  if (feed.targetPlatform !== expected.targetPlatform) {
    problems.push(`targetPlatform is ${JSON.stringify(feed.targetPlatform)}; expected ${expected.targetPlatform}`)
  }
  if (feed.engines?.vscode !== expected.vscodeRange) {
    problems.push(`engines.vscode is ${JSON.stringify(feed.engines?.vscode)}; expected ${expected.vscodeRange}`)
  }
  if (expected.url !== undefined && feed.url !== expected.url) {
    problems.push(`url is ${JSON.stringify(feed.url)}; expected ${expected.url}`)
  }
  return problems
}

/**
 * Read both records, measure the VSIX, then write or verify the feed.
 * @returns {Promise<void>} settles after the feed was written or verified.
 */
async function main() {
  const vsixPath = resolve(option('--vsix', join(extensionRoot, 'dsh-vscode.vsix')))
  const releasePath = resolve(option('--release', join(extensionRoot, 'release.json')))
  const manifestPath = resolve(option('--manifest', join(extensionRoot, 'package.json')))
  const outPath = resolve(option('--out', join(dirname(vsixPath), 'release-feed.json')))
  const baseUrl = option('--base-url', '')
  const notes = option('--notes', '')
  const verify = args.includes('--verify')

  if (!existsSync(vsixPath)) fail(`dsh: the VSIX is missing: ${vsixPath}`)
  if (!existsSync(releasePath)) fail(`dsh: the release record is missing: ${releasePath}`)
  if (!existsSync(manifestPath)) fail(`dsh: the extension manifest is missing: ${manifestPath}`)

  const record = JSON.parse(readFileSync(releasePath, 'utf8'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version = record?.extension?.version
  if (typeof version !== 'string' || valid(version) === null) {
    fail(`dsh: ${releasePath} carries no semver extension.version: ${JSON.stringify(version)}`)
  }
  const recordedDigest = record?.extension?.sha256
  if (typeof recordedDigest !== 'string') {
    fail(`dsh: ${releasePath} carries no extension.sha256; run package:release first`)
  }
  const vsCodeRange = manifest?.engines?.vscode
  if (typeof vsCodeRange !== 'string' || vsCodeRange === '') {
    fail(`dsh: ${manifestPath} declares no engines.vscode range`)
  }
  const publisher = manifest?.publisher
  const name = typeof manifest?.name === 'string' ? manifest.name.replace(/^@[^/]+\//u, '') : ''
  if (typeof publisher !== 'string' || publisher === '' || name === '') {
    fail(`dsh: ${manifestPath} declares no publisher and name; the extension identifier cannot be derived`)
  }
  const extensionId = option('--extension-id', `${publisher}.${name}`)

  const { sha256, size } = await digestFile(vsixPath)
  if (sha256 !== recordedDigest) {
    fail(`dsh: the VSIX ${vsixPath} hashes to ${sha256}, but ${releasePath} records ${recordedDigest}; the files describe different builds`)
  }
  const recordedSize = record?.extension?.size
  if (typeof recordedSize === 'number' && recordedSize !== size) {
    fail(`dsh: the VSIX ${vsixPath} has ${String(size)} bytes, but ${releasePath} records ${String(recordedSize)}`)
  }
  const runtime = record?.runtime
  const targetPlatform = typeof runtime?.platform === 'string' && typeof runtime?.arch === 'string'
    ? `${runtime.platform}-${runtime.arch}`
    : 'universal'
  const fileName = vsixPath.split(/[\\/]/u).pop() ?? 'dsh-vscode.vsix'
  const forShare = args.includes('--windows-share')
  if (forShare && baseUrl !== '') fail('dsh: choose --windows-share or --base-url')
  if (forShare && !isSharePackage(fileName)) fail('dsh: the Windows share needs a dsh-vscode VSIX file name')
  const url = forShare ? fileName : baseUrl === '' ? undefined : downloadUrl(baseUrl, fileName)

  process.stdout.write(`vsix ${vsixPath}\n  sha256 ${sha256}\n  size ${String(size)} bytes\n`)
  const expected = { extensionId, version, sha256, size, targetPlatform, vscodeRange: vsCodeRange, url }

  if (verify) {
    if (!existsSync(outPath)) fail(`dsh: the feed is missing: ${outPath}`)
    const feed = JSON.parse(readFileSync(outPath, 'utf8'))
    const problems = feedDisagreements(feed, expected)
    if (problems.length > 0) {
      fail(`dsh: the feed ${outPath} does not match ${vsixPath}:\n  ${problems.join('\n  ')}`)
    }
    process.stdout.write(`feed ${outPath} matches ${version} (${sha256})\n`)
    return
  }

  if (url === undefined) fail('dsh: --base-url or --windows-share is required to write a feed')
  const feed = buildFeed({ ...expected, notes })
  writeFileSync(outPath, `${JSON.stringify(feed, null, 2)}\n`)
  process.stdout.write(`wrote ${outPath}\n  ${extensionId} ${version} ${targetPlatform}\n  ${url}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
