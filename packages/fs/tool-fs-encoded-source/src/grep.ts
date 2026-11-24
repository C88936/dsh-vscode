/**
 * The model-facing `grep` tool with encoding-aware candidate handling.
 *
 * A single ripgrep pass cannot match a Chinese pattern inside GBK bytes: the
 * pattern is UTF-8, and the file's bytes are not. The tool therefore keeps the
 * ordinary ripgrep pass over every candidate, enumerates the same candidates
 * with `rg --files` under the same path/include/ignore rules, resolves each
 * candidate's encoding with the shared policy, and re-searches a temporary
 * UTF-8 mirror of only the files that resolve to a legacy codepage. Paths are
 * mapped back to their workspace display form and de-duplicated by
 * `(path, lineNumber)`, preferring the decoded mirror text.
 *
 * Everything else is the installed `grep`: the same schema, argv builder,
 * `--json` parser, preview and match caps, grouping and formatting, complete
 * result spill, timeout, cancellation, and search-card metadata.
 *
 * @module @deepseek-ai/dsh-tool-fs-encoded-source/grep
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  buildGrepCommand,
  formatGrepMatches,
  formatGrepOutput,
  parseGrepArgs,
  parseGrepMatches,
  presentGrepCall,
  presentGrepResult,
  previewLine,
  runRipgrep,
  toWorkdirRelative,
  trySaveFormattedResult,
} from '@deepseek-ai/dsh-tool-fs-search'
import type { GrepInput, GrepMatch, GrepToolCaps } from '@deepseek-ai/dsh-tool-fs-search'
import type { EncodingPolicy, PolicyLocation } from './encoding-policy.ts'
import { configuredEncoding, fallbackEncoding } from './encoding-policy.ts'
import { decodeBytes, isLegacyEncoding } from './decode.ts'
import type { DecodedSourceText } from './decode.ts'

/** One candidate file enumerated for encoding resolution. */
interface Candidate {
  /** Absolute path on the host. */
  filePath: string
  /** Display path relative to the resolved workdir. */
  displayPath: string
}

/** One legacy candidate and its decoded text, ready to mirror. */
interface LegacyCandidate extends Candidate {
  /** Decoded UTF-8 text of the whole file. */
  text: string
}

/** Binary Visual Basic form resources are never matched as text. */
const BINARY_SOURCE_SUFFIX = '.frx'

/** Suffix of one mirrored candidate inside the temporary directory. */
const MIRROR_SUFFIX = '.mirror'

/**
 * Whether one reported path names a binary form resource.
 * @param path - the reported path.
 * @returns whether the path ends with the binary `.frx` suffix.
 */
function isBinarySource(path: string): boolean {
  return path.toLowerCase().endsWith(BINARY_SOURCE_SUFFIX)
}

/**
 * The argv that lists the candidate files a search covers, under the same
 * path, include, and ignore rules as the search itself.
 * @param input - the validated `grep` arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildCandidateCommand(input: GrepInput): string[] {
  const parts = ['--files']
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * Enumerate the files one search covers. A single-file target is used as the
 * only candidate, because `rg --files` treats a file argument as a filter
 * rather than a root.
 * @param ctx - the plugin context; execution uses its filesystem and subprocess services.
 * @param exec - the tool execution; supplies cancellation and the session workdir.
 * @param input - the validated `grep` arguments.
 * @param caps - the resolved grep caps.
 * @param workdir - the resolved working directory.
 * @returns the candidates, in ripgrep's order.
 */
async function enumerateCandidates(
  ctx: Context,
  exec: ToolExecution,
  input: GrepInput,
  caps: GrepToolCaps,
  workdir: string,
): Promise<Candidate[]> {
  if (input.path !== undefined) {
    const target = await ctx.fs.resolve(input.path, { cwd: workdir, signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info?.type === 'file') {
      return [{ filePath: ctx.fs.processPath(target), displayPath: toWorkdirRelative(input.path, workdir) }]
    }
  }
  const run = await runRipgrep(
    ctx, exec, 'grep', buildCandidateCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes,
  )
  if (run.noMatches) return []
  const candidates: Candidate[] = []
  for (const line of run.stdout.split('\n')) {
    if (line.length === 0 || isBinarySource(line)) continue
    candidates.push({
      filePath: isAbsolute(line) ? line : join(workdir, line),
      displayPath: toWorkdirRelative(line, workdir),
    })
  }
  return candidates
}

/**
 * Decode every candidate the policy resolves to a legacy codepage. A candidate
 * that cannot be read, exceeds the byte cap, or cannot be decoded is skipped:
 * the ordinary ripgrep pass already covered its raw bytes, and a mirror of
 * unknown text would invent matches.
 * @param ctx - the plugin context providing the filesystem service.
 * @param exec - the tool execution; supplies cancellation and the session workdir.
 * @param candidates - the enumerated candidates.
 * @param policy - the resolved encoding policy.
 * @param sourceMaxBytes - byte cap on one candidate read.
 * @param workdir - the resolved working directory.
 * @returns the legacy candidates with their decoded text.
 */
async function legacyCandidates(
  ctx: Context,
  exec: ToolExecution,
  candidates: readonly Candidate[],
  policy: EncodingPolicy,
  sourceMaxBytes: number,
  workdir: string,
): Promise<LegacyCandidate[]> {
  const legacy: LegacyCandidate[] = []
  for (const candidate of candidates) {
    const location: PolicyLocation = { filePath: candidate.filePath, workdir }
    // Only a path the policy may decode needs its bytes: a candidate with no
    // matching rule or fallback is searched by the ordinary ripgrep pass, so
    // reading and decoding it would add one full file read per candidate
    // without changing the result.
    if (configuredEncoding(policy, location) === undefined && fallbackEncoding(policy, location) === undefined) continue
    let decoded: DecodedSourceText
    try {
      const target = await ctx.fs.resolve(candidate.filePath, { cwd: workdir, signal: exec.signal })
      const bytes = await ctx.fs.readBytes(target, exec.signal, sourceMaxBytes)
      decoded = decodeBytes(bytes, policy, location, candidate.displayPath)
    } catch {
      // An unreadable, oversized (`FS_TOO_LARGE`), or undecodable (`FS_NOT_TEXT`)
      // candidate is not text this policy can mirror; the raw pass already
      // searched its bytes. Cancellation still propagates.
      exec.signal.throwIfAborted()
      continue
    }
    if (isLegacyEncoding(decoded.encoding)) legacy.push({ ...candidate, text: decoded.text })
  }
  return legacy
}

/**
 * Search a temporary UTF-8 mirror of the legacy candidates with one ripgrep
 * invocation, then map each match back to its workspace path.
 *
 * The mirror lives in a fresh temporary directory that is removed on success,
 * failure, and abort. `--no-ignore --hidden` keeps a host-level ignore file
 * from hiding the mirror files themselves; the candidate set already applied
 * the workspace's own ignore rules.
 * @param ctx - the plugin context; execution uses its subprocess service.
 * @param exec - the tool execution; supplies cancellation and the session workdir.
 * @param pattern - the model's ripgrep regular expression.
 * @param legacy - the legacy candidates and their decoded text.
 * @param caps - the resolved grep caps.
 * @returns the matches, in mirror order, keyed back to workspace display paths.
 */
async function searchMirror(
  ctx: Context,
  exec: ToolExecution,
  pattern: string,
  legacy: readonly LegacyCandidate[],
  caps: GrepToolCaps,
): Promise<GrepMatch[]> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-encoded-source-'))
  try {
    const byName = new Map<string, string>()
    for (const [index, candidate] of legacy.entries()) {
      const name = `${index}${MIRROR_SUFFIX}`
      await writeFile(join(directory, name), candidate.text, 'utf8')
      byName.set(name, candidate.displayPath)
    }
    const run = await runRipgrep(
      ctx,
      exec,
      'grep',
      ['--json', `--regexp=${pattern}`, '--no-ignore', '--hidden', '--', directory],
      caps.rawOutputMaxBytes,
      caps.graceMs,
      caps.stderrMaxBytes,
    )
    if (run.noMatches) return []
    const matches: GrepMatch[] = []
    for (const raw of parseGrepMatches(run.stdout)) {
      const displayPath = byName.get(basename(raw.path))
      if (displayPath === undefined) continue
      matches.push({ path: displayPath, lineNumber: raw.lineNumber, line: raw.line })
    }
    return matches
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Merge the ordinary pass with the mirror pass, de-duplicating by
 * `(path, lineNumber)` and preferring the decoded mirror text for a match both
 * passes found.
 * @param base - matches from the ordinary pass, in output order.
 * @param mirror - matches from the mirror pass, in output order.
 * @returns the merged matches, keeping the ordinary pass's order.
 */
export function mergeMatches(base: readonly GrepMatch[], mirror: readonly GrepMatch[]): GrepMatch[] {
  const merged = [...base]
  const positions = new Map<string, number>()
  for (const [index, match] of merged.entries()) positions.set(`${match.path}\u0000${match.lineNumber}`, index)
  for (const match of mirror) {
    const key = `${match.path}\u0000${match.lineNumber}`
    const at = positions.get(key)
    if (at === undefined) {
      positions.set(key, merged.length)
      merged.push(match)
    } else {
      merged[at] = match
    }
  }
  return merged
}

/**
 * Apply the shared inline cap to the complete match list, exactly as the
 * installed `grep` does: preview each line and keep the first `maxMatches`.
 * @param matches - every parsed match.
 * @param maxMatches - the inline match cap.
 * @param maxLineBytes - the per-line preview budget.
 * @returns the retention outcome over the previewed matches.
 */
function retainMatches(matches: readonly GrepMatch[], maxMatches: number, maxLineBytes: number): RetainedItems<GrepMatch> {
  const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: maxMatches })
  for (const match of matches) retainer.push({ ...match, line: previewLine(match.line, maxLineBytes) })
  return retainer.finish()
}

/**
 * One `tool/result` metadata payload for the search card: the retained matches
 * grouped by file, the pre-cap total, and the truncation flag.
 */
type SearchMeta = { shape: 'matches'; files: { path: string; matches: { lineNumber: number; line: string }[] }[]; truncated: boolean; total: number }

/** Group retained matches by file in first-seen order, matching the model-facing text grouping. */
function groupMatchesByFile(matches: readonly GrepMatch[]): { path: string; matches: { lineNumber: number; line: string }[] }[] {
  const byFile = new Map<string, { lineNumber: number; line: string }[]>()
  for (const match of matches) {
    const entry = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group === undefined) byFile.set(match.path, [entry])
    else group.push(entry)
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

/** The serialized UTF-8 byte size of one meta payload (the size persisted and re-sent). */
function metaBytes(meta: SearchMeta): number {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8')
}

/**
 * Project retained matches into the search-card payload, bounding the
 * serialized bytes by dropping trailing file groups and marking the result
 * truncated. A single group too large to fit is kept: the invariant is a
 * bounded payload wherever droppable, never an empty card hiding a real result.
 * @param retained - the retention outcome over the complete match list.
 * @param maxMetaBytes - the serialized-metadata byte budget.
 * @returns the projected metadata.
 */
function grepSearchMeta(retained: RetainedItems<GrepMatch>, maxMetaBytes: number): SearchMeta {
  const meta: SearchMeta = {
    shape: 'matches',
    files: groupMatchesByFile(retained.items),
    truncated: retained.truncated,
    total: retained.seen,
  }
  if (metaBytes(meta) <= maxMetaBytes) return meta
  const files = [...meta.files]
  while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop()
  return { ...meta, files, truncated: true }
}

/** Format one already-retained match list for the Native surface. */
function renderRetainedGrep(retained: RetainedItems<GrepMatch>, spillRef?: SpillRef): string {
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/**
 * Return the accepted canonical value only when this tool still owns a direct
 * successful top-level call and no downstream policy replaced either projection.
 * @param ctx - the tool plugin context used to resolve the live scoped owner.
 * @param tool - the exact registered definition whose value may be projected.
 * @param exec - the completed execution identity.
 * @param result - the canonical result before post-policy decisions are applied.
 * @param decision - the composed downstream post-policy decision.
 * @returns the canonical value to project, or `undefined` when spill must defer.
 */
function acceptedDirectCallValue(
  ctx: Context,
  tool: ToolDefinition,
  exec: ToolExecution,
  result: ToolExecutionResult,
  decision: PostToolDecision,
): JsonValue | undefined {
  if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.parent !== undefined || exec.name !== tool.name || result.isError
    || ctx.tools.get(exec.name, exec.agent) !== tool) return undefined
  return result.value
}

/**
 * Register the encoding-aware `grep` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its subprocess service.
 * @param caps - the deployment's resolved grep caps.
 * @param policy - the deployment's resolved encoding policy.
 * @param sourceMaxBytes - byte cap on one candidate read while resolving encodings.
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps, policy: EncodingPolicy, sourceMaxBytes: number): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. '
      + `Returns up to ${caps.maxMatches} matches; a larger result reports where the complete match list was saved.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRetainedGrep(retainMatches(value.matches, caps.maxMatches, caps.maxLineBytes)),
      }],
      presentationMeta: (_args, value) =>
        grepSearchMeta(retainMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      const base: GrepMatch[] = []
      if (!run.noMatches) {
        for (const raw of parseGrepMatches(run.stdout)) {
          if (isBinarySource(raw.path)) continue
          base.push({ path: toWorkdirRelative(raw.path, run.workdir), lineNumber: raw.lineNumber, line: raw.line })
        }
      }
      const candidates = await enumerateCandidates(ctx, exec, input, caps, run.workdir)
      const legacy = await legacyCandidates(ctx, exec, candidates, policy, sourceMaxBytes, run.workdir)
      if (legacy.length === 0) return { matches: base }
      const mirrored = await searchMirror(ctx, exec, input.pattern, legacy, caps)
      return { matches: mergeMatches(base, mirrored) }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { matches: GrepMatch[] } | undefined
    if (value === undefined) return decision
    const matches = value.matches
    if (matches.length <= caps.maxMatches) return decision
    // The spill artifact holds the COMPLETE result: preview each line, but keep
    // every match (no inline cap), so the recovery file is the full search.
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }))
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`,
    )
    return {
      kind: 'accept',
      content: [{
        type: 'text',
        text: renderRetainedGrep(retainMatches(matches, caps.maxMatches, caps.maxLineBytes), spillRef),
      }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
