/**
 * VS Code editor adapter for DSH.
 *
 * Registers the `/open <path>` human command; the command asks the extension to
 * show that file in the VS Code editor. Like the terminal provider, this module
 * is loaded from the extension directory and relies on a global the companion
 * installs before boot.
 * @module @deepseek-ai/dsh-vscode/provider/editor-provider
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'

/** Result the extension reports for one open request. */
export interface OpenFileOutcome {
  readonly ok: boolean
  readonly error?: string
}

/** Globals the companion owns before this row mounts. */
interface ProviderGlobals {
  __DSH_VSCODE_OPEN_FILE__?: (path: string) => Promise<OpenFileOutcome>
}

/** Stable plugin name. */
export const name = 'vscode-editor'

/** Services required before registering the command. */
export const inject = ['commands']

/**
 * Register the `/open` command.
 * @param ctx - plugin context carrying the human-command registry.
 */
export function apply(ctx: Context): void {
  const globals = globalThis as ProviderGlobals
  ctx.effect(() => ctx.commands.register({
    name: 'open',
    description: 'Open a file in the VS Code editor',
    input: { hint: 'path/to/file' },
    handler: async (invocation) => {
      const target = invocation.rawInput.trim()
      if (target === '') return { kind: 'error', text: 'Usage: /open <path>' }
      const open = globals.__DSH_VSCODE_OPEN_FILE__
      if (open === undefined) return { kind: 'error', text: 'The VS Code editor bridge is unavailable.' }
      const cwd = invocation.agent.session.header.cwd
      const outcome = await open(cwd === undefined ? target : resolve(cwd, target))
      return outcome.ok
        ? { kind: 'success', text: `Opened ${target} in VS Code.` }
        : { kind: 'error', text: outcome.error ?? `Could not open ${target}.` }
    },
  }), 'vscode-editor: /open command')
}
