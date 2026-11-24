/**
 * The model-facing `read` tool, byte-identical in arguments, output object,
 * envelope, caps, and card presentation to `@deepseek-ai/dsh-tool-fs`'s `read`,
 * but decoding through the configured encoding policy.
 *
 * The one deliberate difference is the observation: the `fs/observed` present
 * observation is emitted only when the bytes were proven strict UTF-8 (a UTF-8
 * BOM counts). A file decoded through a legacy codepage stays read-only,
 * because the write and edit guards treat an unobserved target as "create
 * only" and refuse to replace it.
 *
 * @module @deepseek-ai/dsh-tool-fs-encoded-source/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { EncodingPolicy } from './encoding-policy.ts'
import { decodeBytes, decodeStream } from './decode.ts'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import type { ReadWindow, WindowResult } from './read-render.ts'

/** Resolved read-tool caps — plugin config after defaulting (see `Config`). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
}

/** Validated `read` arguments after defaulting. */
export interface ReadInput {
  filePath: string
  offset: number
  limit: number
}

/** Size of one byte window requested from the filesystem while streaming a read. */
const BYTE_WINDOW = 64 * 1024

/** Binary Visual Basic form resources are never read as text. */
const BINARY_SOURCE_SUFFIX = '.frx'

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/**
 * Reject the targets the read window cannot address.
 * @param value - one candidate integer.
 * @param name - the argument name for the failure message.
 * @returns the accepted value.
 */
function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Resolve the current directory and cancellation for a filesystem call.
 * @param ctx - context containing the working-directory service.
 * @param exec - tool execution supplying the agent and cancellation.
 * @returns filesystem resolution options for this call.
 */
async function sessionResolveOptions(
  ctx: Context,
  exec: ToolExecution,
): Promise<{ cwd?: string; signal?: AbortSignal }> {
  const cwd = exec.agent === undefined
    ? undefined
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  return { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal }
}

/**
 * The session working directory a relative policy entry resolves against.
 * @param ctx - context containing the working-directory service.
 * @param exec - tool execution supplying the agent and cancellation.
 * @returns the absolute working directory.
 */
async function sessionWorkdir(ctx: Context, exec: ToolExecution): Promise<string> {
  return exec.agent === undefined
    ? ctx.workingDirectory.defaultDirectory
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
}

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including the owning Agent and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 * @throws {FsError} `FS_NOT_FOUND` for an absent target and `FS_NOT_REGULAR_FILE` for a non-file.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, await sessionResolveOptions(ctx, exec))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}

/**
 * Stream one regular file as raw byte windows without buffering it whole.
 * @param ctx - the plugin context providing the filesystem service.
 * @param target - the resolved regular file.
 * @param signal - aborts the read.
 * @returns the byte windows in file order.
 */
async function* byteWindows(ctx: Context, target: FsTarget, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let offset = 0
  for (;;) {
    const window = await ctx.fs.readByteRange(target, { offset, length: BYTE_WINDOW }, signal)
    if (window.length === 0) return
    yield window
    offset += window.length
  }
}

/**
 * Register the encoding-aware `read` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps.
 * @param policy - the deployment's resolved encoding policy.
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps, policy: EncodingPolicy): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value) => {
        const input = parseReadArgs(args, caps.limit)
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            ...truncatedByBytes ? { truncatedByBytes: true } : {},
          }),
        }]
      },
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      if (input.filePath.toLowerCase().endsWith(BINARY_SOURCE_SUFFIX)) {
        throw new FsError(`cannot read "${input.filePath}": ${BINARY_SOURCE_SUFFIX} is a binary resource`, 'FS_NOT_TEXT')
      }
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)
      const workdir = await sessionWorkdir(ctx, exec)
      const location = { filePath: ctx.fs.processPath(target), workdir }
      const request: ReadWindow = {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: caps.maxLineLength,
        maxBytes: caps.maxBytes,
      }
      // Stream when the file is large OR its size is unknown, so a size-less
      // backend never buffers an arbitrarily large file.
      let window: WindowResult
      let observed: boolean
      if (info.size === undefined || info.size >= caps.streamMinSize) {
        const stream = await decodeStream(byteWindows(ctx, target, exec.signal), policy, location, target.displayPath)
        window = await buildWindow(stream.chunks, request, target.displayPath)
        observed = stream.observed
      } else {
        const decoded = decodeBytes(await ctx.fs.readBytes(target, exec.signal, caps.streamMinSize), policy, location, target.displayPath)
        window = await buildWindow([decoded.text], request, target.displayPath)
        observed = decoded.observed
      }
      const outcome = {
        path: ctx.fs.processPath(target),
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
      }
      // A legacy decode proves nothing about the bytes a write guard would
      // replace, so only a strict UTF-8 read records the present observation.
      if (observed) ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
