/** Historical comparisons remain available while any native tab references them. */
import { beforeEach, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

const mock = vi.hoisted(() => ({ command: vi.fn(), register: vi.fn(), tabs: vi.fn(), groups: [] as { tabs: { input: object }[] }[] }))
vi.mock('vscode', () => ({
  Uri: { parse: (value: string) => ({ scheme: value.split(':')[0], path: value.slice(value.indexOf(':') + 1) }) },
  workspace: { registerTextDocumentContentProvider: mock.register },
  window: { tabGroups: { get all() { return mock.groups }, onDidChangeTabs: mock.tabs } },
  commands: { executeCommand: mock.command },
  TabInputTextDiff: class { constructor(readonly original: vscode.Uri, readonly modified: vscode.Uri) {} },
  TabInputText: class { constructor(readonly uri: vscode.Uri) {} },
  l10n: { t: (text: string) => text },
}))
import { TabInputTextDiff } from 'vscode'
import { DiffDocuments } from '../src/host/diff.ts'

beforeEach(() => { vi.resetAllMocks(); mock.groups = [] })

function setup() {
  const diff = new DiffDocuments()
  diff.register({ push: vi.fn() })
  const provider = mock.register.mock.calls[0]?.[1] as vscode.TextDocumentContentProvider
  const changed = mock.tabs.mock.calls[0]?.[0] as () => void
  return { diff, read: (uri: vscode.Uri) => provider.provideTextDocumentContent(uri, {} as vscode.CancellationToken), changed }
}

it('retains twenty closed comparisons once each and rejects expired history', async () => {
  const { diff, read } = setup()
  await diff.show({ title: 'first', before: 'old first', after: '' })
  const first = mock.command.mock.calls[0]?.[1] as vscode.Uri
  for (let i = 1; i < 20; i++) await diff.show({ title: `${i}`, before: 'old', after: 'new' })
  expect(read(first)).toBe('old first')
  const empty = mock.command.mock.calls[0]?.[2] as vscode.Uri
  expect(read(empty)).toBe('')
  await diff.show({ title: '21', before: 'old', after: 'new' })
  expect(() => read(first)).toThrow('expired')
})

it('pins open diff tabs beyond twenty comparisons and releases after close', async () => {
  const { diff, read, changed } = setup()
  mock.command.mockImplementation((_name: string, before: vscode.Uri, after: vscode.Uri) => {
    mock.groups.push({ tabs: [{ input: new TabInputTextDiff(before, after) }] })
    changed()
  })
  for (let i = 0; i < 45; i++) await diff.show({ title: `${i}`, before: `old ${i}`, after: `new ${i}` })
  const first = mock.command.mock.calls[0]?.[1] as vscode.Uri
  expect(read(first)).toBe('old 0')
  mock.groups = []
  changed()
  expect(() => read(first)).toThrow('expired')
  diff.dispose()
  const last = mock.command.mock.calls[44]?.[2] as vscode.Uri
  expect(() => read(last)).toThrow('expired')
})

it('removes both sides when VS Code rejects opening the diff', async () => {
  const { diff, read } = setup()
  mock.command.mockRejectedValue(new Error('editor failed'))
  await expect(diff.show({ title: 'failed', before: 'old', after: 'new' })).rejects.toThrow('editor failed')
  for (const uri of mock.command.mock.calls[0]?.slice(1, 3) ?? []) expect(() => read(uri as vscode.Uri)).toThrow('expired')
})

it('does not reuse historical URIs after an extension restart', async () => {
  const first = setup()
  await first.diff.show({ title: 'old instance', before: 'old history', after: 'after' })
  const oldUri = mock.command.mock.calls[0]?.[1] as vscode.Uri
  first.diff.dispose()
  const next = new DiffDocuments()
  next.register({ push: vi.fn() })
  await next.show({ title: 'new instance', before: 'different history', after: 'after' })
  const newUri = mock.command.mock.calls[1]?.[1] as vscode.Uri
  expect(newUri.path).not.toBe(oldUri.path)
  const provider = mock.register.mock.calls[1]?.[1] as vscode.TextDocumentContentProvider
  expect(() => provider.provideTextDocumentContent(oldUri, {} as vscode.CancellationToken)).toThrow('expired')
})
