/**
 * Fixture byte generation for the encoding tests: legacy codepages are encoded
 * at test time by inverting the platform decoder's own table, so the suite
 * commits no binary fixtures and every fixture byte is produced by the same
 * converter the reader uses.
 */

/** Windows codepages this support module can encode. */
export type LegacyRange = 'gbk' | 'gb2312'

/** One character to its legacy byte sequence, built once per range. */
const tables = new Map<LegacyRange, Map<string, readonly number[]>>()

/**
 * Whether a two-byte sequence belongs to the GB2312 subset that GBK extends.
 * @param high - lead byte.
 * @param low - trail byte.
 * @returns whether the pair sits in the GB2312 hanzi area.
 */
function inGb2312(high: number, low: number): boolean {
  return high >= 0xb0 && high <= 0xf7 && low >= 0xa1 && low <= 0xfe
}

/**
 * Build (or reuse) the inverse table for one range.
 * @param range - the codepage to invert.
 * @returns one character to its two-byte sequence.
 */
function tableFor(range: LegacyRange): Map<string, readonly number[]> {
  const cached = tables.get(range)
  if (cached !== undefined) return cached
  const decoder = new TextDecoder('gbk')
  const table = new Map<string, readonly number[]>()
  for (let high = 0x81; high <= 0xfe; high++) {
    for (let low = 0x40; low <= 0xfe; low++) {
      if (range === 'gb2312' && !inGb2312(high, low)) continue
      if (low === 0x7f) continue
      const character = decoder.decode(Uint8Array.from([high, low]))
      if (character.length !== 1 || character === '\uFFFD' || table.has(character)) continue
      table.set(character, [high, low])
    }
  }
  tables.set(range, table)
  return table
}

/**
 * Encode text as GBK or GB2312 bytes. ASCII and tab/newline pass through
 * unchanged, as they do in both codepages.
 * @param text - the text to encode.
 * @param range - the legacy range; GB2312 is the restricted subset.
 * @returns the encoded bytes.
 * @throws when a character has no mapping in the requested range.
 */
export function encodeLegacy(text: string, range: LegacyRange = 'gbk'): Uint8Array {
  const table = tableFor(range)
  const bytes: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const encoded = table.get(character)
    if (encoded === undefined) throw new Error(`no ${range} mapping for ${JSON.stringify(character)}`)
    bytes.push(...encoded)
  }
  return Uint8Array.from(bytes)
}

/**
 * Encode text as GB18030. The two-byte area is identical to GBK for the
 * characters this suite uses, so the GBK table applies.
 * @param text - the text to encode.
 * @returns the encoded bytes.
 */
export function encodeGb18030(text: string): Uint8Array {
  return encodeLegacy(text, 'gbk')
}

/**
 * Encode text as UTF-8 without a byte-order mark.
 * @param text - the text to encode.
 * @returns the encoded bytes.
 */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Encode text as UTF-8 with a byte-order mark.
 * @param text - the text to encode.
 * @returns the BOM followed by the UTF-8 body.
 */
export function encodeUtf8Bom(text: string): Uint8Array {
  return join([Uint8Array.from([0xef, 0xbb, 0xbf]), encodeUtf8(text)])
}

/**
 * Encode text as UTF-16LE, optionally with its byte-order mark.
 * @param text - the text to encode.
 * @param bom - whether to prepend `FF FE`.
 * @returns the encoded bytes.
 */
export function encodeUtf16Le(text: string, bom = false): Uint8Array {
  const body = Buffer.from(text, 'utf16le')
  return join([...(bom ? [Uint8Array.from([0xff, 0xfe])] : []), new Uint8Array(body)])
}

/**
 * Encode text as UTF-16BE, optionally with its byte-order mark.
 * @param text - the text to encode.
 * @param bom - whether to prepend `FE FF`.
 * @returns the encoded bytes.
 */
export function encodeUtf16Be(text: string, bom = false): Uint8Array {
  const swapped = new Uint8Array(Buffer.from(text, 'utf16le'))
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const head = swapped[index] ?? 0
    swapped[index] = swapped[index + 1] ?? 0
    swapped[index + 1] = head
  }
  return join([...(bom ? [Uint8Array.from([0xfe, 0xff])] : []), swapped])
}

/**
 * Concatenate byte sequences.
 * @param parts - the sequences in order.
 * @returns their concatenation.
 */
export function join(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
