/** Encoding policy order: BOM, configured rules, strict UTF-8, restricted fallback. */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeBytes } from '../src/decode.ts'
import { bomDecision, compileGlob, resolveEncodingPolicy } from '../src/encoding-policy.ts'
import { encodeLegacy, encodeUtf8, encodeUtf8Bom } from './support/codec.ts'

const workdir = resolve('/workspace')

/**
 * Build a policy location for one workspace-relative path.
 * @param relative - path inside the fixture workspace.
 * @returns the location the decoder resolves against.
 */
function at(relative: string): { filePath: string; workdir: string } {
  return { filePath: join(workdir, relative), workdir }
}

/** Chinese fixture text, encoded per case below. */
const TEXT = '第一行 中文\n第二行 代码\n'

describe('encoding policy order', () => {
  it('lets a UTF-8 BOM win over a configured rule', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '**/*.cls', encoding: 'gbk', mode: 'decode' }] })
    const decoded = decodeBytes(encodeUtf8Bom(TEXT), policy, at('form/Main.cls'), 'form/Main.cls')
    expect(decoded.encoding).toBe('utf-8-bom')
    expect(decoded.hasBom).toBe(true)
    expect(decoded.text).toBe(TEXT)
    expect(decoded.observed).toBe(true)
  })

  it('lets a UTF-16 BOM win over a configured rule and stays unobserved', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '**/*.cls', encoding: 'gbk', mode: 'decode' }] })
    const bytes = new Uint8Array(Buffer.from(TEXT, 'utf16le'))
    const decoded = decodeBytes(encodeUtf8Bom(TEXT), policy, at('form/Main.cls'), 'form/Main.cls')
    expect(decoded.encoding).toBe('utf-8-bom')
    const utf16 = decodeBytes(new Uint8Array([0xff, 0xfe, ...bytes]), policy, at('form/Main.cls'), 'form/Main.cls')
    expect(utf16.encoding).toBe('utf-16le')
    expect(utf16.hasBom).toBe(true)
    expect(utf16.observed).toBe(false)
    expect(utf16.text).toBe(TEXT)
  })

  it('lets a configured rule beat strict UTF-8', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.cls', encoding: 'gbk', mode: 'decode' }] })
    // ASCII is valid UTF-8 and valid GBK; only the resolved encoding shows
    // which check won, and the rule is an explicit statement about this path.
    const decoded = decodeBytes(encodeUtf8('First line\nSecond line\n'), policy, at('Main.cls'), 'Main.cls')
    expect(decoded.encoding).toBe('gbk')
    expect(decoded.observed).toBe(false)
  })

  it('decodes a legacy file through a configured rule', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.cls', encoding: 'gbk', mode: 'decode' }] })
    const decoded = decodeBytes(encodeLegacy(TEXT), policy, at('Main.cls'), 'Main.cls')
    expect(decoded.encoding).toBe('gbk')
    expect(decoded.text).toBe(TEXT)
    expect(decoded.observed).toBe(false)
  })

  it('applies rules in configured order and matches without a slash against the basename', () => {
    const policy = resolveEncodingPolicy({
      rules: [
        { glob: '**/legacy/*.bas', encoding: 'gb2312', mode: 'decode' },
        { glob: '*.bas', encoding: 'gbk', mode: 'decode' },
      ],
    })
    expect(decodeBytes(encodeLegacy(TEXT, 'gb2312'), policy, at('legacy/Module.bas'), 'Module.bas').encoding).toBe('gb2312')
    expect(decodeBytes(encodeLegacy(TEXT), policy, at('modern/Module.bas'), 'Module.bas').encoding).toBe('gbk')
  })

  it('matches rule globs case-insensitively', () => {
    const policy = resolveEncodingPolicy({ rules: [{ glob: '*.CLS', encoding: 'gbk', mode: 'decode' }] })
    expect(decodeBytes(encodeLegacy(TEXT), policy, at('Main.cls'), 'Main.cls').encoding).toBe('gbk')
  })

  it('lets strict UTF-8 beat a configured fallback', () => {
    const policy = resolveEncodingPolicy({
      fallback: [{ encoding: 'gbk', directories: ['legacy'], extensions: ['.cs'] }],
    })
    const decoded = decodeBytes(encodeUtf8(TEXT), policy, at('legacy/Program.cs'), 'Program.cs')
    expect(decoded.encoding).toBe('utf-8')
    expect(decoded.text).toBe(TEXT)
    expect(decoded.observed).toBe(true)
  })

  it('decodes a non-UTF-8 file through the fallback admitted by its directory and extension', () => {
    const policy = resolveEncodingPolicy({
      fallback: [{ encoding: 'gbk', directories: ['legacy'], extensions: ['.bas'] }],
    })
    const decoded = decodeBytes(encodeLegacy(TEXT), policy, at('legacy/Module.bas'), 'Module.bas')
    expect(decoded.encoding).toBe('gbk')
    expect(decoded.text).toBe(TEXT)
    expect(decoded.observed).toBe(false)
  })

  it('refuses the fallback outside its directories', () => {
    const policy = resolveEncodingPolicy({
      fallback: [{ encoding: 'gbk', directories: ['legacy'], extensions: ['.bas'] }],
    })
    expect(() => decodeBytes(encodeLegacy(TEXT), policy, at('modern/Module.bas'), 'modern/Module.bas'))
      .toThrow(/not valid UTF-8 and no configured fallback encoding applies/u)
  })

  it('refuses the fallback outside its extensions', () => {
    const policy = resolveEncodingPolicy({
      fallback: [{ encoding: 'gbk', directories: ['legacy'], extensions: ['.bas'] }],
    })
    expect(() => decodeBytes(encodeLegacy(TEXT), policy, at('legacy/notes.txt'), 'legacy/notes.txt'))
      .toThrow(/not valid UTF-8/u)
  })

  it('admits an extension-only fallback anywhere in the workspace', () => {
    const policy = resolveEncodingPolicy({ fallback: [{ encoding: 'gb18030', directories: [], extensions: ['.frm'] }] })
    expect(decodeBytes(encodeLegacy(TEXT), policy, at('deep/nested/Form.frm'), 'Form.frm').encoding).toBe('gb18030')
  })

  it('rejects a fallback that limits nothing', () => {
    expect(() => resolveEncodingPolicy({ fallback: [{ encoding: 'gbk', directories: [], extensions: [] }] }))
      .toThrow(/must name at least one directory or extension/u)
  })

  it('rejects a blank rule glob', () => {
    expect(() => resolveEncodingPolicy({ rules: [{ glob: '  ', encoding: 'gbk', mode: 'decode' }] }))
      .toThrow(/must be a non-empty glob/u)
  })

  it('fails an undecodable file with FS_NOT_TEXT', () => {
    const policy = resolveEncodingPolicy({})
    try {
      decodeBytes(Uint8Array.from([0xff, 0xff, 0xff]), policy, at('broken.txt'), 'broken.txt')
      throw new Error('expected a decode failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'FS_NOT_TEXT' })
    }
  })
})

describe('BOM detection', () => {
  it('recognizes each BOM and its byte length', () => {
    expect(bomDecision(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ encoding: 'utf-8-bom', bytes: 3 })
    expect(bomDecision(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toEqual({ encoding: 'utf-16le', bytes: 2 })
    expect(bomDecision(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toEqual({ encoding: 'utf-16be', bytes: 2 })
    expect(bomDecision(Uint8Array.from([0x41, 0x42]))).toBeUndefined()
  })
})

describe('glob compilation', () => {
  it.each([
    ['*.cls', 'Main.cls', true],
    ['*.cls', 'src/Main.cls', false],
    ['**/*.bas', 'src/deep/Main.bas', true],
    ['**/*.bas', 'Main.bas', true],
    ['src/**/*.cs', 'src/a/b/Program.cs', true],
    ['src/**/*.cs', 'src/Program.cs', true],
    ['src/?ain.cs', 'src/Main.cs', true],
    ['src/*.{cs,vb}', 'src/Main.vb', true],
    ['src/*.{cs,vb}', 'src/Main.txt', false],
  ])('matches %s against %s as %s', (glob, candidate, expected) => {
    expect(compileGlob(glob).test(candidate)).toBe(expected)
  })
})
