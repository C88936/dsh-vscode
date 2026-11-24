/** Owner-only Skill catalog routes for the VS Code webview. */
import { isAbsolute, normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

interface Skill {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly path?: string
  readonly invocation: { readonly userInvocable: boolean }
}

/** Skill catalog methods shared by the Host and the owner-only local catalog. */
export interface ExtensionSkillRegistry {
  /** Read the catalog for the selected workspace. */
  list(options?: { cwd?: string }): Promise<Skill[]>
  /** Read the selected entry and its instructions. */
  get(name: string, options?: { cwd?: string }): Promise<(Skill & { content: string }) | undefined>
}

interface ManagedRoutesOptions {
  readonly cwd: string
  readonly localSkills: ExtensionSkillRegistry
}

/**
 * Mount the owner-only Skill route and release it with the Host.
 *
 * MCP servers are not handled here: the composition mounts
 * `@deepseek-ai/dsh-mcp-manager`, which owns server lifecycle, credentials and
 * the settings editor.
 * @param ctx Host Cordis context.
 * @param options Working directory and the local Skill catalog.
 */
export function registerManagedExtensions(ctx: Context, options: ManagedRoutesOptions): void {
  const connection = ctx.get('connection') as HostConnectionHandle | undefined
  if (connection === undefined) return
  const skills = ctx.get('skills') as ExtensionSkillRegistry | undefined
  const workspaces = ctx.get('workspaceRegistry') as { list(): readonly { path: string }[] } | undefined
  const samePath = (left: string, right: string) => process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right)
  ctx.effect(() => connection.fetch.register({
    path: '/api/vscode.skills', methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      if (skills === undefined) return Response.json({ error: 'skills-unavailable' }, { status: 503 })
      const query = new URL(request.url).searchParams
      const requestedCwd = query.get('cwd')
      if (requestedCwd && (!isAbsolute(requestedCwd) || !samePath(requestedCwd, options.cwd)
        && workspaces?.list().some(item => samePath(item.path, requestedCwd)) !== true)) {
        return Response.json({ error: 'workspace-not-found' }, { status: 404 })
      }
      const cwd = requestedCwd || options.cwd
      const name = query.get('name')
      if (name === null) {
        const catalog = new Map((await skills.list({ cwd })).map(item => [item.name, item]))
        for (const item of await options.localSkills.list({ cwd })) catalog.set(item.name, item)
        return Response.json([...catalog.values()].filter(item => item.invocation.userInvocable))
      }
      const item = await options.localSkills.get(name, { cwd }) ?? await skills.get(name, { cwd })
      return item?.invocation.userInvocable === true ? Response.json(item) : Response.json({ error: 'skill-not-found' }, { status: 404 })
    },
  }), 'vscode: skill catalog route')
}
