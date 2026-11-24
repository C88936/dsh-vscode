/**
 * The deployment's encoding policy for workspace text: the ordered resolution
 * order BOM → configured per-file rule → strict UTF-8 → restricted legacy
 * fallback, plus every cap the three replacement tools apply.
 *
 * `Config` is the plugin's schemastery schema; {@link resolveEncodingPolicy}
 * turns its rules and fallbacks into the matcher the decoder consults. A rule
 * is an explicit statement about a path's codepage, so it also overrides a
 * byte sequence that happens to be valid UTF-8: an operator who declares
 * `*.cls` as GBK means it. The fallback is the only implicit choice, and it
 * applies only inside the configured directories or extensions.
 *
 * @module @deepseek-ai/dsh-tool-fs-encoded-source/encoding-policy
 */

import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/**
 * One legacy codepage a file may be decoded through. `gbk` and `gb2312` both
 * decode with the GBK converter: GB2312 is a subset of GBK, and the platform
 * decoder named `gb2312` is that same converter.
 */
export type LegacyEncoding = 'gbk' | 'gb2312' | 'gb18030' | 'utf-16le' | 'utf-16be'

/** Every encoding a read may resolve to, including the two UTF-8 forms. */
export type SourceEncoding = 'utf-8' | 'utf-8-bom' | LegacyEncoding

/** One ordered per-file rule: the first glob that matches a path decides its encoding. */
export interface SourceEncodingRule {
  /** Glob matched against the workdir-relative path, or the basename when it contains no `/`. */
  glob: string
  /** Encoding this file's bytes are decoded with. */
  encoding: SourceEncoding
  /** Only `decode` is defined: this package never writes legacy files. */
  mode: 'decode'
}

/**
 * One opt-in legacy fallback. It applies only when the strict UTF-8 decode
 * fails, and only to paths matching its `directories` or `extensions`; an
 * entry that names neither limits nothing and is rejected at load.
 */
export interface LegacyFallbackRule {
  /** Codepage the fallback decodes with. */
  encoding: LegacyEncoding
  /** Directories the fallback is limited to, absolute or relative to the session working directory. Empty means "any directory this entry's extensions reach". */
  directories: string[]
  /** File suffixes (with the leading dot) the fallback is limited to. Empty means "any extension inside this entry's directories". */
  extensions: string[]
}

/** Plugin config: the encoding policy plus every read, grep, and glob cap. */
export interface Config {
  /** Whether an over-cap `glob` page is sampled across top-level entries; required so the ordering choice is explicit. */
  sampleOverCapGlobResults: boolean
  /** Ordered per-file encoding rules. The first matching glob decides. */
  rules?: SourceEncodingRule[]
  /** Opt-in legacy codepage fallbacks, consulted only after strict UTF-8 fails. */
  fallback?: LegacyFallbackRule[]
  /** Max bytes of one file the grep mirror reads to resolve its encoding. */
  sourceMaxBytes?: number
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory; streamed reads decode BOM, rules, or strict UTF-8 only. */
  readStreamMinSize?: number
  /** Max paths one `glob` call retains inline. */
  globMaxResults?: number
  /** Max flat matches one `grep` call retains inline. */
  grepMaxMatches?: number
  /** Max bytes retained for one matched-line preview. */
  grepMaxLineBytes?: number
  /** Max bytes of one search's serialized `presentationMeta`. */
  searchMetaMaxBytes?: number
  /** Max complete raw `rg` stdout one search parses. */
  rawOutputMaxBytes?: number
  /** Terminate-escalation grace (ms) handed to the subprocess seam. */
  graceMs?: number
  /** Max bytes retained for one search's stderr tail. */
  stderrMaxBytes?: number
  /** Cooperative tool-call budget (ms) on all three tools. */
  timeoutMs?: number
}

/** Every encoding a rule may name. */
const DECODE_ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gbk', 'gb2312', 'gb18030'] as const

/** Every encoding a fallback may name; a UTF-8 fallback would contradict "strict UTF-8 first". */
const LEGACY_ENCODINGS = ['utf-16le', 'utf-16be', 'gbk', 'gb2312', 'gb18030'] as const

/** Default cap on the bytes one grep candidate mirror reads (16 MiB). */
export const SOURCE_MAX_BYTES = 16 * 1024 * 1024

/** Default and maximum number of lines returned by one `read` call, mirroring `tool-fs`. */
export const READ_LIMIT = 2000

/** Default maximum characters returned for a single read line, mirroring `tool-fs`. */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for the selected read lines, mirroring `tool-fs`. */
export const READ_MAX_BYTES = 50 * 1024

/** Default streaming threshold, mirroring `tool-fs`: files at or above it stream. */
export const READ_STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Default inline `glob` path cap, mirroring `tool-fs-search`. */
export const GLOB_MAX_RESULTS = 100

/** Default inline `grep` match cap, mirroring `tool-fs-search`. */
export const GREP_MAX_MATCHES = 250

/** Default per-line preview budget, mirroring `tool-fs-search`. */
export const GREP_MAX_LINE_BYTES = 2000

/** Default serialized search-metadata budget, mirroring `tool-fs-search`. */
export const SEARCH_META_MAX_BYTES = 65_536

/** Default raw search-output budget, mirroring `tool-fs-search`. */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000

/** Default terminate-escalation grace, mirroring `tool-fs-search`. */
export const SEARCH_GRACE_MS = 3_000

/** Default stderr diagnostic-tail budget, mirroring `tool-fs-search`. */
export const SEARCH_STDERR_MAX_BYTES = 64 * 1024

/** Default cooperative tool-call budget, mirroring `tool-fs-search`. */
export const SEARCH_TIMEOUT_MS = 30_000

/** Plugin config schema; every deployment-varying choice is a validated field. */
export const Config: z<Config> = z.object({
  sampleOverCapGlobResults: z.boolean().required(),
  rules: z.array(z.object({
    glob: z.string().required(),
    encoding: z.union([...DECODE_ENCODINGS]),
    mode: z.const('decode').default('decode'),
  })).default([]),
  fallback: z.array(z.object({
    encoding: z.union([...LEGACY_ENCODINGS]),
    directories: z.array(z.string()).default([]),
    extensions: z.array(z.string()).default([]),
  })).default([]),
  sourceMaxBytes: z.number().default(SOURCE_MAX_BYTES),
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(READ_STREAM_MIN_SIZE),
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  searchMetaMaxBytes: z.number().default(SEARCH_META_MAX_BYTES),
  rawOutputMaxBytes: z.number().default(RAW_OUTPUT_MAX_BYTES),
  graceMs: z.number().default(SEARCH_GRACE_MS),
  stderrMaxBytes: z.number().default(SEARCH_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(SEARCH_TIMEOUT_MS),
})

/** Where a path sits relative to the session working directory, for rule and fallback matching. */
export interface PolicyLocation {
  /** Absolute path of the file being decoded. */
  readonly filePath: string
  /** Absolute session working directory the deployment's relative configuration resolves against. */
  readonly workdir: string
}

/** One resolved, validated encoding policy. */
export interface EncodingPolicy {
  /** Rules in configured order, each with its compiled matcher. */
  readonly rules: readonly {
    readonly glob: string
    readonly encoding: SourceEncoding
    readonly matcher: RegExp
  }[]
  /** Fallbacks in configured order, each with its directories resolved to absolute posix paths. */
  readonly fallback: readonly {
    readonly encoding: LegacyEncoding
    readonly directories: readonly string[]
    readonly extensions: readonly string[]
  }[]
}

/** The BOM a byte prefix starts with. */
export interface BomDecision {
  /** Encoding the BOM declares. */
  readonly encoding: 'utf-8-bom' | 'utf-16le' | 'utf-16be'
  /** Bytes the BOM occupies. */
  readonly bytes: number
}

/** Longest BOM this reader recognizes. */
const BOM_PROBE_BYTES = 3

/**
 * Resolve a file's BOM. A BOM wins over every configured rule: it is the only
 * statement the file itself makes about its codepage.
 * @param head - the first bytes of the file; fewer than three is still valid input.
 * @returns the declared encoding and its byte length, or `undefined` without a BOM.
 */
export function bomDecision(head: Uint8Array): BomDecision | undefined {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: 'utf-8-bom', bytes: 3 }
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bytes: 2 }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bytes: 2 }
  return undefined
}

/** The number of bytes {@link bomDecision} needs to answer. */
export const BOM_BYTES = BOM_PROBE_BYTES

/**
 * Escape one literal glob segment into a regular-expression body.
 * @param segment - literal glob characters.
 * @returns the escaped body.
 */
function escapeLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Compile one glob into an anchored regular expression. Supported syntax is
 * `*` (within a path segment), `**` (across segments), `?` (one character),
 * and `{a,b}` (alternation); every other character is literal.
 * @param glob - the configured glob.
 * @returns the compiled expression, matched case-insensitively.
 */
export function compileGlob(glob: string): RegExp {
  let source = ''
  let index = 0
  while (index < glob.length) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 2
        if (glob[index] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (character === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (character === '{') {
      const end = glob.indexOf('}', index + 1)
      if (end > index + 1) {
        const alternatives = glob.slice(index + 1, end).split(',')
        source += `(?:${alternatives.map(escapeLiteral).join('|')})`
        index = end + 1
        continue
      }
    }
    source += escapeLiteral(character ?? '')
    index += 1
  }
  return new RegExp(`^${source}$`, 'iu')
}

/**
 * The path a rule glob is matched against: workdir-relative posix when the
 * file is inside the working directory, absolute posix otherwise.
 * @param location - the file and the working directory.
 * @returns the posix-form match target.
 */
function matchTarget(location: PolicyLocation): string {
  const absolute = isAbsolute(location.filePath)
    ? location.filePath
    : resolve(location.workdir, location.filePath)
  const rel = relative(location.workdir, absolute)
  const inside = rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
  return (inside ? rel : absolute).split(sep).join('/')
}

/**
 * The basename of a match target, for globs that name no directory.
 * @param target - the posix match target.
 * @returns the final path segment.
 */
function baseName(target: string): string {
  return target.slice(target.lastIndexOf('/') + 1)
}

/**
 * Resolve and validate the configured policy. Fallback entries that name
 * neither a directory nor an extension would apply everywhere, which is what
 * the opt-in fallback exists to avoid, so they fail the plugin load instead of
 * silently widening.
 * @param config - the schema-validated plugin config.
 * @returns the resolved policy.
 * @throws when a rule names a blank glob or a fallback limits nothing.
 */
export function resolveEncodingPolicy(config: {
  rules?: readonly SourceEncodingRule[]
  fallback?: readonly LegacyFallbackRule[]
}): EncodingPolicy {
  const rules = (config.rules ?? []).map((rule, index) => {
    if (rule.glob.trim().length === 0) throw new Error(`tool-fs-encoded-source: rules[${index}].glob must be a non-empty glob`)
    return { glob: rule.glob, encoding: rule.encoding, matcher: compileGlob(rule.glob) }
  })
  const fallback = (config.fallback ?? []).map((entry, index) => {
    if (entry.directories.length === 0 && entry.extensions.length === 0) {
      throw new Error(
        `tool-fs-encoded-source: fallback[${index}] must name at least one directory or extension; `
        + 'an unrestricted legacy fallback would decode every invalid UTF-8 file instead of the configured subset',
      )
    }
    return {
      encoding: entry.encoding,
      directories: entry.directories.map(directory => directory.split('\\').join('/')),
      extensions: entry.extensions.map(extension => extension.toLowerCase()),
    }
  })
  return { rules, fallback }
}

/**
 * Resolve the configured rule for one file.
 * @param policy - the resolved policy.
 * @param location - the file and the working directory.
 * @returns the declared encoding, or `undefined` when no rule matches.
 */
export function configuredEncoding(policy: EncodingPolicy, location: PolicyLocation): SourceEncoding | undefined {
  const target = matchTarget(location)
  const basename = baseName(target)
  for (const rule of policy.rules) {
    const candidate = rule.glob.includes('/') ? target : basename
    if (rule.matcher.test(candidate)) return rule.encoding
  }
  return undefined
}

/**
 * Test whether a directory configuration contains a file, resolving relative
 * directories against the session working directory.
 * @param directory - one configured directory.
 * @param location - the file and the working directory.
 * @returns whether the file sits inside the directory.
 */
function directoryContains(directory: string, location: PolicyLocation): boolean {
  const absolute = isAbsolute(directory) ? directory : resolve(location.workdir, directory)
  const file = isAbsolute(location.filePath) ? location.filePath : resolve(location.workdir, location.filePath)
  const rel = relative(absolute, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve the configured legacy fallback for one file. A fallback applies when
 * every limit it declares admits the file: inside one of its directories, and
 * ending with one of its extensions.
 * @param policy - the resolved policy.
 * @param location - the file and the working directory.
 * @returns the fallback encoding, or `undefined` when no entry admits the file.
 */
export function fallbackEncoding(policy: EncodingPolicy, location: PolicyLocation): LegacyEncoding | undefined {
  const suffix = extname(location.filePath).toLowerCase()
  for (const entry of policy.fallback) {
    if (entry.directories.length > 0 && !entry.directories.some(directory => directoryContains(directory, location))) continue
    if (entry.extensions.length > 0 && !entry.extensions.includes(suffix)) continue
    return entry.encoding
  }
  return undefined
}
