/**
 * Native plugin selection: the extension host turns a validated Webview
 * request into one local absolute path, and refuses a remote or virtual
 * selection the companion cannot install from.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isPickLocalPathMessage, pickLocalPath,
  type PickDirectoryOptions, type PickedUri, type PickLocalPathMessage,
} from '../src/host/local-path-picker.ts'

const ARCHIVE_REQUEST: PickLocalPathMessage = { type: 'pick-local-path', id: 7, kind: 'file' }
const FOLDER_REQUEST: PickLocalPathMessage = { type: 'pick-local-path', id: 8, kind: 'folder' }

const FILE: PickedUri = { scheme: 'file', authority: '', fsPath: 'C:\\plugins\\dsh-better-sidebar-2.0.0.tgz' }
const FOLDER: PickedUri = { scheme: 'file', authority: '', fsPath: 'C:\\plugins\\sidebar' }
const ARCHIVE_OPTIONS = {
  canSelectFiles: true,
  canSelectFolders: false,
  canSelectMany: false,
  openLabel: 'Choose for the DSH plugin install',
  filters: { 'Plugin archive': ['tgz', 'tar.gz'] },
}
const FOLDER_OPTIONS = {
  canSelectFiles: false,
  canSelectFolders: true,
  canSelectMany: false,
  openLabel: 'Choose for the DSH plugin install',
}

/**
 * @param answer - what the dialog returns, or the failure it rejects with.
 * @returns a dialog host double and its call record.
 */
function dialog(answer: readonly PickedUri[] | undefined | Error) {
  const showOpenDialog = vi.fn((_options: PickDirectoryOptions): Promise<readonly PickedUri[] | undefined> =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))
  return { showOpenDialog }
}

describe('isPickLocalPathMessage', () => {
  it('accepts one integer request with a selection kind and refuses every other message', () => {
    expect(isPickLocalPathMessage(ARCHIVE_REQUEST)).toBe(true)
    expect(isPickLocalPathMessage(FOLDER_REQUEST)).toBe(true)
    expect(isPickLocalPathMessage({ type: 'pick-local-path', id: 0, kind: 'folder' })).toBe(true)
    expect(isPickLocalPathMessage({ type: 'open-resource', id: 1, kind: 'file' })).toBe(false)
    expect(isPickLocalPathMessage({ type: 'pick-local-path', id: 1 })).toBe(false)
    expect(isPickLocalPathMessage({ type: 'pick-local-path', id: 1, kind: 'both' })).toBe(false)
    expect(isPickLocalPathMessage({ type: 'pick-local-path', id: 1.5, kind: 'file' })).toBe(false)
    expect(isPickLocalPathMessage({ type: 'pick-local-path', id: '1', kind: 'file' })).toBe(false)
    expect(isPickLocalPathMessage(null)).toBe(false)
    expect(isPickLocalPathMessage('pick-local-path')).toBe(false)
  })
})

describe('pickLocalPath', () => {
  it('opens an archive dialog and returns the selected local path', async () => {
    const host = dialog([FILE])
    expect(await pickLocalPath(host, ARCHIVE_REQUEST)).toEqual({ type: 'pick-result', id: 7, path: FILE.fsPath })
    expect(host.showOpenDialog).toHaveBeenCalledExactlyOnceWith(ARCHIVE_OPTIONS)
  })

  it('opens a folder dialog for a package directory', async () => {
    const host = dialog([FOLDER])
    expect(await pickLocalPath(host, FOLDER_REQUEST)).toEqual({ type: 'pick-result', id: 8, path: FOLDER.fsPath })
    // Windows cannot select files and folders in one dialog, so the folder request offers folders alone.
    expect(host.showOpenDialog).toHaveBeenCalledExactlyOnceWith(FOLDER_OPTIONS)
  })

  it('reports a cancelled dialog and an empty selection as a no-op', async () => {
    expect(await pickLocalPath(dialog(undefined), ARCHIVE_REQUEST)).toEqual({ type: 'pick-result', id: 7, reason: 'cancelled' })
    expect(await pickLocalPath(dialog([]), FOLDER_REQUEST)).toEqual({ type: 'pick-result', id: 8, reason: 'cancelled' })
  })

  it('refuses a remote or virtual file system the companion does not run on', async () => {
    const remote: PickedUri = { scheme: 'vscode-remote', authority: 'ssh-remote+host', fsPath: '/srv/plugins/pkg.tgz' }
    expect(await pickLocalPath(dialog([remote]), ARCHIVE_REQUEST)).toEqual({ type: 'pick-result', id: 7, reason: 'unsupported' })
    // A uniform-naming-convention share keeps the file scheme and remains local to Windows.
    const share: PickedUri = { scheme: 'file', authority: 'fileserver', fsPath: '\\\\fileserver\\plugins\\pkg.tgz' }
    expect(await pickLocalPath(dialog([share]), ARCHIVE_REQUEST)).toEqual({ type: 'pick-result', id: 7, path: share.fsPath })
    const empty: PickedUri = { scheme: 'file', authority: '', fsPath: '' }
    expect(await pickLocalPath(dialog([empty]), FOLDER_REQUEST)).toEqual({ type: 'pick-result', id: 8, reason: 'unsupported' })
  })

  it('reports a dialog that could not open', async () => {
    expect(await pickLocalPath(dialog(new Error('no dialog server')), ARCHIVE_REQUEST))
      .toEqual({ type: 'pick-result', id: 7, reason: 'failed', detail: 'no dialog server' })
  })
})
