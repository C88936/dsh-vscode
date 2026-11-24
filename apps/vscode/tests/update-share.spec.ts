import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { downloadUpdate } from '../src/host/update/download.ts'
import { parseUpdateManifest } from '../src/host/update/manifest.ts'
import { readUpdateShare, windowsUpdateShare } from '../src/host/update/share.ts'

const packageName = 'dsh-vscode-0.2.2-alpha.3.vsix'
const bytes = Buffer.from('staged package bytes')
const directory = String.raw`\\server\releases\dsh`

function manifest(url: string) {
  return JSON.stringify({
    schemaVersion: 'dsh-vscode-update/v1', extensionId: 'deepseek-ai.dsh-vscode', version: '0.2.2-alpha.3',
    engines: { vscode: '^1.96.0' }, targetPlatform: 'win32-x64', url, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), publishedAt: '2026-11-20T12:00:00.000Z',
  })
}

it('accepts the configured UNC directory and confines a share feed to a VSIX file name', () => {
  expect(windowsUpdateShare(`${directory}\\`)).toBe(directory)
  expect(windowsUpdateShare(`${directory}\\..`)).toBeUndefined()
  expect(windowsUpdateShare(String.raw`\\?\UNC\server\releases`)).toBeUndefined()
  expect(parseUpdateManifest(manifest(packageName), directory)).toMatchObject({ ok: true })
  expect(parseUpdateManifest(manifest(packageName))).toMatchObject({ ok: false, problem: { field: 'url' } })
  for (const url of [`../${packageName}`, `${directory}\\${packageName}`, `https://elsewhere/${packageName}`]) {
    expect(parseUpdateManifest(manifest(url), directory)).toMatchObject({ ok: false, problem: { field: 'url' } })
  }
})

it.runIf(process.platform === 'win32')('verifies bytes read through the Windows file transport before staging', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-update-share-'))
  try {
    await writeFile(join(folder, packageName), bytes)
    await writeFile(join(folder, 'release-feed.json'), manifest(packageName))
    const response = readUpdateShare(folder, 'release-feed.json', AbortSignal.timeout(5_000))
    const parsed = parseUpdateManifest(await response.text(), folder)
    if (!parsed.ok) throw Error(parsed.problem.detail)
    const destination = join(folder, 'updates')
    const options = { manifest: parsed.manifest, directory: destination }
    const verified = await downloadUpdate(options)
    if (!verified.ok) throw Error(verified.failure.detail)
    expect(await readFile(verified.downloaded.path)).toEqual(bytes)
    await writeFile(join(folder, packageName), Buffer.alloc(bytes.length))
    expect(await downloadUpdate(options)).toMatchObject({ ok: false, failure: { code: 'digest-mismatch' } })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
