/**
 * The encoding-aware replacement suite for a mixed legacy and UTF-8 workspace:
 * `read`, `grep`, and `glob` with the same names, arguments, results, caps, and
 * card presentation as the installed tools, plus a configured codepage policy.
 *
 * This is a function plugin (no default export). Mount it in place of
 * `@deepseek-ai/dsh-tool-fs`'s `read` (set that row's `read: false`) and of the
 * `@deepseek-ai/dsh-tool-fs-search` row, which it replaces entirely.
 *
 * @module @deepseek-ai/dsh-tool-fs-encoded-source
 */

import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Config, resolveEncodingPolicy } from './encoding-policy.ts'
import { applyReadTool } from './read.ts'
import { applyGrepTool } from './grep.ts'
import { applyEncodedGlobTool } from './glob.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs-encoded-source'

/** Services required by the replacement suite (`spillStore` stays optional, read through `ctx.get()`). */
export const inject = ['tools', 'fs', 'systemPrompt', 'subprocess', 'workingDirectory']

export { Config }

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every cap counts items, bytes, characters, or milliseconds — a positive integer, or the arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs-encoded-source: ${name} must be a positive integer`)
  }
}

/**
 * Register the encoding-aware `read`, `grep`, and `glob` tools.
 *
 * Load-time validation covers every cap, the timer bound the subprocess seam
 * grants, and the encoding policy itself: a fallback entry that limits nothing
 * fails the load instead of decoding the whole workspace through one codepage.
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('sourceMaxBytes', resolved.sourceMaxBytes)
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  assertPositiveInteger('globMaxResults', resolved.globMaxResults)
  assertPositiveInteger('grepMaxMatches', resolved.grepMaxMatches)
  assertPositiveInteger('grepMaxLineBytes', resolved.grepMaxLineBytes)
  assertPositiveInteger('searchMetaMaxBytes', resolved.searchMetaMaxBytes)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-fs-encoded-source: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  const policy = resolveEncodingPolicy(resolved)
  applyReadTool(ctx, {
    limit: resolved.readLimit,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    streamMinSize: resolved.readStreamMinSize,
  }, policy)
  applyGrepTool(ctx, {
    maxMatches: resolved.grepMaxMatches,
    maxLineBytes: resolved.grepMaxLineBytes,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  }, policy, resolved.sourceMaxBytes)
  applyEncodedGlobTool(ctx, {
    sampleOverCapGlobResults: resolved.sampleOverCapGlobResults,
    maxResults: resolved.globMaxResults,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
}
