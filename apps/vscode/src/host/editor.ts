/**
 * VS Code editor integration for DSH requests.
 * @module @deepseek-ai/dsh-vscode/host/editor
 */
import { extname, join } from 'node:path'
import * as vscode from 'vscode'

/** Outcome of one editor request. */
export interface OpenFileResult {
  readonly ok: boolean
  readonly error?: string
}

/** Absolute path test for both POSIX and Windows forms. */
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/u

/**
 * Show text at its line, images in VS Code, and Office/PDF in the system viewer.
 * A system viewer requires a registered application. Failed opens return an
 * actionable error to the caller; no file or unsaved editor buffer is written.
 * @param path - absolute or workspace-relative file path.
 * @param cwd - bound workspace directory for a relative path; the live first folder is only a fallback.
 * @param line - 1-based line to reveal and place the cursor on.
 * @returns whether the document opened.
 */
export async function openFileInEditor(path: string, cwd?: string, line?: number): Promise<OpenFileResult> {
  try {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri
    const segments = path.split(/[\\/]/u)
    const uri = ABSOLUTE.test(path)
      ? vscode.Uri.file(path)
      : cwd !== undefined
        ? vscode.Uri.file(join(cwd, ...segments))
        : base !== undefined
          ? vscode.Uri.joinPath(base, ...segments)
          : vscode.Uri.file(join(process.cwd(), path))
    if (/^\.(?:docx?|xlsx?|pptx?|odt|ods|odp|rtf|pdf)$/iu.test(extname(path))) {
      await vscode.workspace.fs.stat(uri)
      if (!await vscode.env.openExternal(uri)) {
        return { ok: false, error: vscode.l10n.t('No application opened this file. Install or choose an Office/PDF viewer, then open the file again.') }
      }
      return { ok: true }
    }
    if (/^\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/iu.test(extname(path))) {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false })
      return { ok: true }
    }
    const document = await vscode.workspace.openTextDocument(uri)
    const selection = line === undefined
      ? undefined
      : new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
    await vscode.window.showTextDocument(document, {
      preview: false,
      ...selection === undefined ? {} : { selection },
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
