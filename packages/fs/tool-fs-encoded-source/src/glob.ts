/**
 * The `glob` tool. Discovery has no encoding dimension — ripgrep lists file
 * names, never content — so the replacement suite registers the installed
 * `applyGlobTool` unchanged rather than reimplementing it. Its schema,
 * modification-time ordering, caps, formatted-result spill, and search card
 * therefore stay byte-identical to the plugin this bundle replaces.
 * @module @deepseek-ai/dsh-tool-fs-encoded-source/glob
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyGlobTool } from '@deepseek-ai/dsh-tool-fs-search'
import type { GlobToolCaps } from '@deepseek-ai/dsh-tool-fs-search'

/**
 * Register the installed `glob` tool with this deployment's caps.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param caps - the resolved glob caps, taken unchanged from this plugin's config.
 */
export function applyEncodedGlobTool(ctx: Context, caps: GlobToolCaps): void {
  applyGlobTool(ctx, caps)
}
