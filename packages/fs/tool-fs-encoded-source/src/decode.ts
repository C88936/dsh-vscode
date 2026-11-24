/**
 * Fatal decoding of workspace bytes under the configured encoding policy.
 *
 * Every path is decoded through a `fatal` decoder, so an invalid or truncated
 * byte sequence fails the read instead of turning into replacement characters.
 * {@link decodeBytes} applies the complete policy (BOM, rules, strict UTF-8,
 * then the restricted legacy fallback) because it holds the whole file;
 * {@link decodeStream} decides from the BOM or a rule alone and otherwise
 * requires strict UTF-8, because it may not rewind a consumed stream.
 *
 * `observed` reports whether the bytes were proven to be strict UTF-8. Only
 * such a read may record the `fs/observed` present observation that a later
 * write or edit guards against: a legacy decode is a read-only view.
 *
 * @module @deepseek-ai/dsh-tool-fs-encoded-source/decode
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import { BOM_BYTES, bomDecision, configuredEncoding, fallbackEncoding } from './encoding-policy.ts'
import type { EncodingPolicy, LegacyEncoding, PolicyLocation, SourceEncoding } from './encoding-policy.ts'

/** One file decoded under the policy, with the encoding that produced its text. */
export interface DecodedSourceText {
  /** Decoded text, without a byte-order mark. */
  text: string
  /** Encoding the bytes were decoded with. */
  encoding: SourceEncoding
  /** Whether the file began with a byte-order mark. */
  hasBom: boolean
  /** Whether the bytes were proven to be strict UTF-8 (with or without a BOM). */
  observed: boolean
}

/** A streamed file whose encoding was decided before any text was emitted. */
export interface DecodedSourceStream {
  /** Encoding the chunks are decoded with. */
  encoding: SourceEncoding
  /** Whether the file began with a byte-order mark. */
  hasBom: boolean
  /** Whether the bytes are being proven strict UTF-8; only then may a read record a present observation. */
  observed: boolean
  /** Decoded text chunks in file order. */
  chunks: AsyncIterable<string>
}

/**
 * Bytes sampled for NUL detection, matching the native read's binary sample.
 * A NUL byte in the sample is the native read's binary signal; a text decode
 * that kept it would surface control characters the native tool refuses.
 */
const BINARY_SAMPLE_BYTES = 8192

/**
 * Reject a byte body the native read would call binary.
 *
 * A UTF-16 body is exempt before the sample is taken: its ASCII characters are
 * NUL bytes by construction, and the resolved encoding already states the
 * layout. Every other encoding is a single-byte or UTF-8 text form whose NUL
 * bytes mean the file is not text.
 * @param body - the bytes after any BOM.
 * @param encoding - the resolved encoding.
 * @param displayPath - the path the model named, used in failure messages.
 * @throws {FsError} `FS_NOT_TEXT` when the sample contains a NUL byte.
 */
function assertTextSample(body: Uint8Array, encoding: SourceEncoding, displayPath: string): void {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return
  if (!body.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return
  throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
}

/** Bytes buffered before the first streamed chunk is decoded: the BOM probe plus the binary sample. */
const STREAM_SAMPLE_BYTES = 8192

/**
 * The platform decoder label for one resolved encoding. */
const DECODER_LABELS: Record<SourceEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  gbk: 'gbk',
  // GB2312 is a subset of GBK, and every platform decoder label for `gb2312`
  // selects this same GBK converter.
  gb2312: 'gbk',
  gb18030: 'gb18030',
}

/**
 * Whether one encoding is a legacy codepage rather than a UTF-8 form.
 * @param encoding - the resolved encoding to classify.
 * @returns whether the encoding is a legacy codepage.
 */
export function isLegacyEncoding(encoding: SourceEncoding): encoding is LegacyEncoding {
  return encoding !== 'utf-8' && encoding !== 'utf-8-bom'
}

/**
 * Build a fatal decoder for one resolved encoding.
 * @param encoding - the resolved encoding.
 * @returns a decoder that throws on an invalid byte sequence.
 */
function decoderFor(encoding: SourceEncoding): TextDecoder {
  return new TextDecoder(DECODER_LABELS[encoding], { fatal: true })
}

/**
 * The read failure for undecodable bytes, carrying the filesystem vocabulary
 * the native read uses for non-text content.
 * @param displayPath - the path the model named.
 * @param encoding - the encoding that rejected the bytes.
 * @param cause - the decoder's rejection.
 * @returns the typed error to throw.
 */
function undecodable(displayPath: string, encoding: SourceEncoding, cause: unknown): FsError {
  const how = encoding === 'utf-8'
    ? 'not valid UTF-8 and no configured fallback encoding applies'
    : `not valid ${encoding}`
  return new FsError(`cannot read "${displayPath}": the file is ${how}`, 'FS_NOT_TEXT', { cause })
}

/**
 * Test whether a byte sequence is strict UTF-8.
 * @param bytes - the complete file bytes.
 * @returns whether a fatal UTF-8 decode accepts every byte.
 */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    // Only an invalid byte sequence rejects; content is not otherwise inspected.
    return false
  }
}

/**
 * Decode one complete file under the configured policy.
 *
 * Resolution order is BOM, the first matching rule (which also overrides bytes
 * that happen to be valid UTF-8, because a rule is an explicit statement about
 * the file), strict UTF-8, then the restricted legacy fallback. Without a BOM,
 * rule, or admitting fallback an undecodable file fails as `FS_NOT_TEXT`.
 * @param bytes - the complete file bytes.
 * @param policy - the resolved encoding policy.
 * @param location - the file path and the session working directory.
 * @param displayPath - the path the model named, used in failure messages.
 * @returns the decoded text, its encoding, and whether it was proven UTF-8.
 * @throws {FsError} `FS_NOT_TEXT` when no configured encoding accepts the bytes.
 */
export function decodeBytes(
  bytes: Uint8Array,
  policy: EncodingPolicy,
  location: PolicyLocation,
  displayPath: string,
): DecodedSourceText {
  const bom = bomDecision(bytes)
  if (bom !== undefined) {
    return decodeWith(bytes.subarray(bom.bytes), bom.encoding, true, displayPath)
  }
  const configured = configuredEncoding(policy, location)
  if (configured !== undefined) {
    return decodeWith(bytes, configured, false, displayPath)
  }
  if (isStrictUtf8(bytes)) {
    assertTextSample(bytes, 'utf-8', displayPath)
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', hasBom: false, observed: true }
  }
  const fallback = fallbackEncoding(policy, location)
  if (fallback !== undefined) return decodeWith(bytes, fallback, false, displayPath)
  throw undecodable(displayPath, 'utf-8', undefined)
}

/**
 * Decode one body with a specific encoding, keeping the observation rule in
 * one place: only a strict UTF-8 decode (with or without a BOM) observed the
 * file as text the write and edit guards may replace.
 * @param body - the bytes after any BOM.
 * @param encoding - the resolved encoding.
 * @param hasBom - whether the file began with a byte-order mark.
 * @param displayPath - the path the model named, used in failure messages.
 * @returns the decoded text with its resolved facts.
 */
function decodeWith(
  body: Uint8Array,
  encoding: SourceEncoding,
  hasBom: boolean,
  displayPath: string,
): DecodedSourceText {
  assertTextSample(body, encoding, displayPath)
  let text: string
  try {
    text = decoderFor(encoding).decode(body)
  } catch (error) {
    throw undecodable(displayPath, encoding, error)
  }
  return {
    text,
    encoding,
    hasBom,
    // A rule can name UTF-8 explicitly; the decode is then still fatal UTF-8,
    // so the bytes are proven UTF-8 either way.
    observed: encoding === 'utf-8' || encoding === 'utf-8-bom',
  }
}

/**
 * Concatenate buffered head chunks into one buffer.
 * @param chunks - the chunks read while probing for a BOM.
 * @returns their concatenation.
 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array()
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

/**
 * Decode a streamed file, deciding its encoding from its first bytes.
 *
 * Only a BOM or a matching rule can name a legacy codepage here; every other
 * stream is decoded as fatal UTF-8, because a stream cannot be rewound after
 * the fallback's precondition (a failed UTF-8 decode) is discovered. A file
 * that needs a legacy fallback must therefore be read whole, which the read
 * tool does below its streaming threshold.
 * @param source - byte chunks in file order.
 * @param policy - the resolved encoding policy.
 * @param location - the file path and the session working directory.
 * @param displayPath - the path the model named, used in failure messages.
 * @returns the decided encoding and the decoded text chunks.
 */
export async function decodeStream(
  source: AsyncIterable<Uint8Array>,
  policy: EncodingPolicy,
  location: PolicyLocation,
  displayPath: string,
): Promise<DecodedSourceStream> {
  const iterator = source[Symbol.asyncIterator]()
  const head: Uint8Array[] = []
  let headBytes = 0
  let finished = false
  while (headBytes < STREAM_SAMPLE_BYTES && !finished) {
    const next = await iterator.next()
    if (next.done) {
      finished = true
      break
    }
    head.push(next.value)
    headBytes += next.value.length
  }
  const buffered = concat(head)
  const bom = bomDecision(buffered.subarray(0, BOM_BYTES))
  const configured = bom === undefined ? configuredEncoding(policy, location) : undefined
  const encoding: SourceEncoding = bom?.encoding ?? configured ?? 'utf-8'
  const bomBytes = bom?.bytes ?? 0
  const observed = encoding === 'utf-8' || encoding === 'utf-8-bom'
  const body = buffered.subarray(bomBytes)
  assertTextSample(body, encoding, displayPath)

  async function* chunks(): AsyncGenerator<string> {
    const decoder = decoderFor(encoding)
    try {
      const first = decoder.decode(body, { stream: true })
      if (first.length > 0) yield first
      while (!finished) {
        const next = await iterator.next()
        if (next.done) {
          finished = true
          break
        }
        const text = decoder.decode(next.value, { stream: true })
        if (text.length > 0) yield text
      }
      const tail = decoder.decode()
      if (tail.length > 0) yield tail
    } catch (error) {
      throw undecodable(displayPath, encoding, error)
    } finally {
      // A consumer that stopped early (a failing read window) releases the
      // source immediately rather than leaving the backend stream open.
      if (!finished) await iterator.return?.(undefined)
    }
  }

  return { encoding, hasBom: bomBytes > 0, observed, chunks: chunks() }
}
