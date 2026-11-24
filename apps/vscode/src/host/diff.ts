/**
 * Read-only virtual documents for DSH's historical before/after comparison.
 *
 * The changed-files card supplies both sides the Host kept for a turn; the
 * extension shows them in a native diff editor without writing either side to
 * the workspace, so the user's files and buffers are untouched. Documents are
 * served under the `dsh-diff` scheme from memory. Open tabs retain their
 * comparisons; up to twenty additional comparisons remain available after close.
 * @module @deepseek-ai/dsh-vscode/host/diff
 */
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'

/** URI scheme owned by this extension for virtual comparison documents. */
const SCHEME = 'dsh-diff'

/** Closed comparisons retained for reopening. Open tabs are never evicted. */
const RETAINED = 20

/** One side of a native comparison. */
export interface DiffRequest {
  /** Title shown by the diff editor. */
  readonly title: string
  /** Historical (left) text. */
  readonly before: string
  /** Current (right) text. */
  readonly after: string
}

/** In-memory provider for the extension's comparison documents. */
export class DiffDocuments {
  private readonly contents = new Map<string, string>()
  private readonly order: string[] = []
  private readonly opening = new Set<string>()

  /**
   * Register the scheme's content provider in the caller's subscriptions.
   * @param subscriptions - extension subscriptions that own the registration.
   */
  register(subscriptions: { push(disposable: vscode.Disposable): void }): void {
    subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: uri => {
        const text = this.contents.get(uri.path)
        if (text === undefined) throw new Error(vscode.l10n.t('This comparison has expired. Reopen it from the changed-files card.'))
        return text
      },
    }))
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { this.prune() }))
  }

  /**
   * Open one comparison in the native diff editor.
   * @param request - title and both sides.
   * @returns settles when the diff editor accepted the comparison.
   */
  async show(request: DiffRequest): Promise<void> {
    const id = `c${randomUUID()}`
    const before = this.remember(id, 'before', request.before)
    const after = this.remember(id, 'after', request.after)
    this.order.push(id)
    this.opening.add(id)
    try {
      await vscode.commands.executeCommand('vscode.diff', before, after, request.title, { preview: false })
    } catch (error) {
      this.release(id)
      this.order.splice(this.order.indexOf(id), 1)
      throw error
    } finally {
      this.opening.delete(id)
      this.prune()
    }
  }

  /** Release every retained document; the extension owns the provider lifetime. */
  dispose(): void {
    this.contents.clear()
    this.order.length = 0
    this.opening.clear()
  }

  private remember(id: string, side: 'before' | 'after', text: string): vscode.Uri {
    const path = `/${id}/${side}`
    this.contents.set(path, text)
    return vscode.Uri.parse(`${SCHEME}:${path}`)
  }

  private prune(): void {
    const pinned = new Set(this.opening)
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input
        const uris = input instanceof vscode.TabInputTextDiff
          ? [input.original, input.modified]
          : input instanceof vscode.TabInputText ? [input.uri] : []
        for (const uri of uris) {
          const id = uri.path.split('/')[1]
          if (uri.scheme === SCHEME && id !== undefined) pinned.add(id)
        }
      }
    }
    const closed = this.order.filter(id => !pinned.has(id))
    for (const id of closed.slice(0, Math.max(0, closed.length - RETAINED))) {
      this.release(id)
      this.order.splice(this.order.indexOf(id), 1)
    }
  }

  private release(id: string): void {
    this.contents.delete(`/${id}/before`)
    this.contents.delete(`/${id}/after`)
  }
}
