/** File routing preserves text selections and delegates binary viewers. */
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  text: vi.fn(), show: vi.fn(), command: vi.fn(), external: vi.fn(), stat: vi.fn(),
}))
vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ fsPath: path }), joinPath: (_base: object, ...parts: string[]) => ({ fsPath: parts.join('/') }) },
  Range: class { constructor(readonly line: number) {} },
  workspace: {
    openTextDocument: mock.text,
    fs: { stat: mock.stat },
    workspaceFolders: [{ uri: { fsPath: 'C:/live-first-folder' } }],
  },
  window: { showTextDocument: mock.show },
  commands: { executeCommand: mock.command }, env: { openExternal: mock.external },
  l10n: { t: (text: string) => text },
}))
import { openFileInEditor } from '../src/host/editor.ts'

beforeEach(() => { vi.resetAllMocks(); mock.external.mockResolvedValue(true) })

it('opens text with its requested line without modifying the buffer', async () => {
  mock.text.mockResolvedValue({ isDirty: true })
  expect(await openFileInEditor('C:/project/code.cpp', undefined, 12)).toEqual({ ok: true })
  expect(mock.show).toHaveBeenCalledWith({ isDirty: true }, { preview: false, selection: expect.objectContaining({ line: 11 }) })
  expect(mock.external).not.toHaveBeenCalled()
})

it.each(['docx', 'xlsx', 'pptx', 'pdf', 'DOC', 'odt'])('opens %s through the system file association', async extension => {
  const path = `C:/中文 空格/result.${extension}`
  expect(await openFileInEditor(path)).toEqual({ ok: true })
  expect(mock.stat).toHaveBeenCalledWith({ fsPath: path })
  expect(mock.external).toHaveBeenCalledWith({ fsPath: path })
  expect(mock.text).not.toHaveBeenCalled()
})

it('reports an unavailable file association', async () => {
  mock.external.mockResolvedValue(false)
  expect(await openFileInEditor('C:/file.pdf')).toEqual({ ok: false, error: expect.stringContaining('viewer') })
})

it('reports a missing file before launching an application', async () => {
  mock.stat.mockRejectedValue(new Error('File not found'))
  expect(await openFileInEditor('C:/missing.docx')).toEqual({ ok: false, error: 'File not found' })
  expect(mock.external).not.toHaveBeenCalled()
})

it('resolves a relative path against the bound workspace before the live first folder', async () => {
  mock.text.mockResolvedValue({ isDirty: false })
  await openFileInEditor('src/a.ts', join('C:', 'bound'))
  expect(mock.text).toHaveBeenCalledWith({ fsPath: join('C:', 'bound', 'src', 'a.ts') })
})

it('uses the VS Code image viewer', async () => {
  expect(await openFileInEditor('C:/image.png')).toEqual({ ok: true })
  expect(mock.command).toHaveBeenCalledWith('vscode.open', { fsPath: 'C:/image.png' }, { preview: false })
  expect(mock.text).not.toHaveBeenCalled()
})
