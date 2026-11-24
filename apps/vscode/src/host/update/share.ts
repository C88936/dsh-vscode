/** Windows directory transport for a trusted intranet update share. */
import { createReadStream } from 'node:fs'
import { win32 } from 'node:path'
import { Readable } from 'node:stream'

const SHARE = /^\\\\[a-z\d][a-z\d.-]*\\[a-z\d_.\-$]+(?:\\[^\\/:*?"<>|\x00-\x1f]+)*\\?$/iu
const PACKAGE = /^dsh-vscode(?:-[a-z0-9][a-z0-9._+-]*)?\.vsix$/iu

/** Maximum size of the release metadata read from a network share. */
export const MAX_SHARE_FEED_BYTES = 65_536

/**
 * @param value - configured directory.
 * @returns a Windows UNC directory with no dot segments or device namespace, or undefined.
 */
export function windowsUpdateShare(value: string): string | undefined {
  if (!SHARE.test(value)) return undefined
  const parts = value.slice(2).replace(/\\$/u, '').split('\\')
  if (parts.some(part => /[. ]$/u.test(part))) return undefined
  return value.replace(/\\$/u, '')
}

/**
 * @param value - package reference read from the feed.
 * @returns whether it names a VSIX alongside the feed.
 */
export function isSharePackage(value: string): boolean {
  return PACKAGE.test(value)
}

/**
 * @param directory - explicitly configured Windows UNC directory.
 * @param name - validated package file name or the fixed feed file name.
 * @param signal - stops reading when the request is cancelled.
 * @returns a streaming response for the existing download and digest pipeline.
 */
export function readUpdateShare(directory: string, name: string, signal?: AbortSignal): Response {
  const stream = createReadStream(win32.join(directory, name), {
    signal,
    ...name === 'release-feed.json' ? { end: MAX_SHARE_FEED_BYTES } : {},
  })
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
  return new Response(body)
}
