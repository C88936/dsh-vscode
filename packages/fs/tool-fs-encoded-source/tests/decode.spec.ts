/** Decoding of the fixture encodings: GBK, GB2312, GB18030, UTF-8, UTF-8 BOM, UTF-16LE/BE. */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeBytes, decodeStream, isStrictUtf8 } from '../src/decode.ts'
import type { EncodingPolicy } from '../src/encoding-policy.ts'
import { resolveEncodingPolicy } from '../src/encoding-policy.ts'
import {
  encodeGb18030,
  encodeLegacy,
  encodeUtf8,
  encodeUtf8Bom,
  encodeUtf16Be,
  encodeUtf16Le,
  join as joinBytes,
} from './support/codec.ts'

const workdir = resolve('/workspace')
const TEXT = '第一行 中文\n第二行 代码\n'

/**
 * Build a policy location for one workspace-relative path.
 * @param relative - path inside the fixture workspace.
 * @returns the location the decoder resolves against.
 */
function at(relative: string): { filePath: string; workdir: string } {
  return { filePath: join(workdir, relative), workdir }
}

/** The fallback policy the legacy cases use: one configured directory and extension set. */
const legacyPolicy: EncodingPolicy = resolveEncodingPolicy({
  fallback: [{ encoding: 'gb18030', directories: ['.'], extensions: ['.cls', '.bas', '.frm'] }],
})

/**
 * Collect an async iterable of strings.
 * @param chunks - the decoded chunks.
 * @returns their concatenation.
 */
async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of chunks) text += chunk
  return text
}

/**
 * Feed byte chunks to the streaming decoder.
 * @param parts - the byte chunks in file order.
 * @param policy - the resolved policy.
 * @param relative - the workspace-relative path.
 * @returns the decoded text and the decided encoding facts.
 */
async function streamed(parts: readonly Uint8Array[], policy: EncodingPolicy, relative: string) {
  const source = (async function* chunks() {
    for (const part of parts) yield part
  })()
  const stream = await decodeStream(source, policy, at(relative), relative)
  return { text: await collect(stream.chunks), encoding: stream.encoding, observed: stream.observed, hasBom: stream.hasBom }
}

describe('decoding each fixture encoding', () => {
  it('decodes GBK Chinese text', () => {
    const decoded = decodeBytes(encodeLegacy(TEXT), legacyPolicy, at('legacy/Main.cls'), 'Main.cls')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'gb18030', hasBom: false, observed: false })
  })

  it('decodes GB2312 Chinese text through a rule', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.bas', encoding: 'gb2312', mode: 'decode' }] })
    const decoded = decodeBytes(encodeLegacy(TEXT, 'gb2312'), policy, at('legacy/Module.bas'), 'Module.bas')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'gb2312', observed: false })
  })

  it('decodes GB18030 Chinese text', () => {
    const decoded = decodeBytes(encodeGb18030(TEXT), legacyPolicy, at('legacy/Form.frm'), 'Form.frm')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'gb18030', observed: false })
  })

  it('decodes UTF-8 and reports the observation', () => {
    const decoded = decodeBytes(encodeUtf8(TEXT), resolveEncodingPolicy({}), at('src/Program.cs'), 'Program.cs')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'utf-8', hasBom: false, observed: true })
  })

  it('decodes UTF-8 with a BOM, stripping the BOM and keeping the observation', () => {
    const decoded = decodeBytes(encodeUtf8Bom(TEXT), resolveEncodingPolicy({}), at('src/App.csproj'), 'App.csproj')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'utf-8-bom', hasBom: true, observed: true })
  })

  it('decodes UTF-16LE with a BOM as a legacy read', () => {
    const decoded = decodeBytes(encodeUtf16Le(TEXT, true), resolveEncodingPolicy({}), at('src/Legacy.cs'), 'Legacy.cs')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'utf-16le', hasBom: true, observed: false })
  })

  it('decodes UTF-16BE with a BOM as a legacy read', () => {
    const decoded = decodeBytes(encodeUtf16Be(TEXT, true), resolveEncodingPolicy({}), at('src/Legacy.cs'), 'Legacy.cs')
    expect(decoded).toMatchObject({ text: TEXT, encoding: 'utf-16be', hasBom: true, observed: false })
  })

  it('fails rather than replacing characters when a configured encoding cannot decode the bytes', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.txt', encoding: 'utf-16le', mode: 'decode' }] })
    expect(() => decodeBytes(Uint8Array.from([0x41, 0x42, 0x43]), policy, at('odd.txt'), 'odd.txt'))
      .toThrow(/not valid utf-16le/u)
  })

  it('reports strict UTF-8 acceptance without inspecting content', () => {
    expect(isStrictUtf8(encodeUtf8(TEXT))).toBe(true)
    expect(isStrictUtf8(encodeLegacy(TEXT))).toBe(false)
  })

  it('rejects a NUL byte sample as binary when no UTF-16 encoding applies', () => {
    expect(() => decodeBytes(Uint8Array.from([0x41, 0x00, 0x42]), resolveEncodingPolicy({}), at('blob.dat'), 'blob.dat'))
      .toThrow(/binary file/u)
  })

  it('rejects a binary body even when a rule names a legacy encoding', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.cls', encoding: 'gbk', mode: 'decode' }] })
    expect(() => decodeBytes(Uint8Array.from([0x41, 0x00, 0x42]), policy, at('odd.cls'), 'odd.cls'))
      .toThrow(/binary file/u)
  })

  it('keeps the NUL bytes a UTF-16 body carries', () => {
    const decoded = decodeBytes(encodeUtf16Le('A', true), resolveEncodingPolicy({}), at('a.cs'), 'a.cs')
    expect(decoded).toMatchObject({ text: 'A', encoding: 'utf-16le', observed: false })
  })
})

describe('streaming decode', () => {
  it('decodes chunks split inside multibyte characters', async () => {
    const bytes = encodeUtf8(TEXT)
    const parts = [bytes.subarray(0, 4), bytes.subarray(4, 5), bytes.subarray(5)]
    const result = await streamed(parts, resolveEncodingPolicy({}), 'src/Program.cs')
    expect(result).toMatchObject({ text: TEXT, encoding: 'utf-8', observed: true, hasBom: false })
  })

  it('strips a UTF-8 BOM split across chunks', async () => {
    const bytes = encodeUtf8Bom(TEXT)
    const result = await streamed([bytes.subarray(0, 1), bytes.subarray(1)], resolveEncodingPolicy({}), 'a.txt')
    expect(result).toMatchObject({ text: TEXT, encoding: 'utf-8-bom', observed: true, hasBom: true })
  })

  it('uses a configured rule for a streamed legacy file', async () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.cls', encoding: 'gbk', mode: 'decode' }] })
    const bytes = encodeLegacy(TEXT)
    const result = await streamed([bytes.subarray(0, 3), bytes.subarray(3)], policy, 'legacy/Main.cls')
    expect(result).toMatchObject({ text: TEXT, encoding: 'gbk', observed: false })
  })

  it('decodes a UTF-16 stream with its BOM', async () => {
    const bytes = encodeUtf16Le(TEXT, true)
    const result = await streamed([bytes.subarray(0, 5), bytes.subarray(5)], resolveEncodingPolicy({}), 'Legacy.cs')
    expect(result).toMatchObject({ text: TEXT, encoding: 'utf-16le', observed: false })
  })

  it('fails a stream whose bytes are not valid UTF-8 and offers no fallback', async () => {
    const bytes = encodeLegacy(TEXT)
    await expect(streamed([bytes], resolveEncodingPolicy({ fallback: [{ encoding: 'gbk', directories: ['.'], extensions: ['.cls'] }] }), 'legacy/Main.cls'))
      .rejects.toThrow(/not valid UTF-8 and no configured fallback encoding applies/u)
  })

  it('handles an empty stream', async () => {
    const result = await streamed([], resolveEncodingPolicy({}), 'empty.txt')
    expect(result).toMatchObject({ text: '', encoding: 'utf-8', observed: true, hasBom: false })
  })

  it('joins a stream whose bytes arrive in one chunk', async () => {
    const result = await streamed([joinBytes([encodeUtf8('晚'), encodeUtf8('上')])], resolveEncodingPolicy({}), 'x.txt')
    expect(result.text).toBe('晚上')
  })

  it('rejects a streamed NUL byte sample as binary', async () => {
    await expect(streamed([Uint8Array.from([0x41, 0x00, 0x42])], resolveEncodingPolicy({}), 'blob.dat'))
      .rejects.toThrow(/binary file/u)
  })
})
