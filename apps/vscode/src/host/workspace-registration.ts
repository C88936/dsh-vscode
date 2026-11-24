/**
 * Register VS Code folders in one DSH application without changing existing
 * Session working directories. The application owns this coordinator; window
 * connections only request registration of their local folder.
 * @module @deepseek-ai/dsh-vscode/host/workspace-registration
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Idempotent folder registration and initial Session creation for one application. */
export class WorkspaceRegistration {
  private readonly pending = new Map<WorkspaceId, Promise<void>>()

  /**
   * @param ctx - application owning the Workspace and Session services.
   * @param log - diagnostic sink for newly created blank Sessions.
   */
  constructor(private readonly ctx: Context, private readonly log: (line: string) => void) {}

  /**
   * Register or reuse an existing directory and seed only an empty Workspace.
   * Concurrent connections to the same canonical Workspace share initialization.
   * Existing memberships and Session directories are preserved. A failed seed
   * leaves the registration available for a later retry; the caller must not
   * report its window ready until this operation succeeds.
   * @param path - fully qualified existing local directory.
   * @returns completion of registration and any initial Session creation.
   * @throws when the directory is invalid or registration/Session creation fails.
   */
  async ensure(path: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('dsh: ctx.workspaceRegistry is unavailable')
    // create canonicalizes and validates even an already registered directory.
    const workspace = await registry.create(path)
    const existing = this.pending.get(workspace.id)
    if (existing !== undefined) {
      await existing
      return
    }
    const attempt = this.seed(workspace).finally(() => { this.pending.delete(workspace.id) })
    this.pending.set(workspace.id, attempt)
    await attempt
  }

  private async seed(workspace: Workspace): Promise<void> {
    if (workspace.sessionIds.length > 0) return
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('dsh: ctx.sessionController is unavailable')
    const session = await sessions.create({ workspaceId: workspace.id })
    this.log(`dsh: created blank VS Code workspace session ${session.sessionId}`)
  }
}
