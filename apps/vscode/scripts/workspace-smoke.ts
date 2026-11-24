/**
 * Verify DSH's filesystem capability against the VS Code workspace.
 *
 * The extension makes the workspace folder the application cwd, so `ctx.fs`
 * resolves workspace-relative paths and reads and writes real files there. This
 * proves the workspace/file path without a provider swap; a
 * `vscode.workspace.fs` provider is only needed for remote or virtual
 * workspaces.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'

interface FsTarget {
  readonly path?: string
}

interface FsService {
  resolve(path: string, options?: { cwd?: string }): Promise<FsTarget>
  readText(target: FsTarget): Promise<string>
  writeText(target: FsTarget, text: string): Promise<void>
  listDir(target: FsTarget): Promise<readonly { name: string }[]>
  processPath(target: FsTarget): string
}

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-workspace-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

// A workspace folder for this run; the extension passes the real VS Code one.
const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-workspace-'))

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  cwd: workspace,
  log: line => { process.stderr.write(`${line}\n`) },
})

const fs = app.ctx.get('fs') as FsService | undefined
if (fs === undefined) throw new Error('ctx.fs is missing')

const target = await fs.resolve('session.md', { cwd: workspace })
await fs.writeText(target, '# written by the DSH workspace smoke\n')
const readBack = await fs.readText(target)
const entries = await fs.listDir(await fs.resolve('.', { cwd: workspace }))
const onDisk = readFileSync(join(workspace, 'session.md'), 'utf8')

process.stdout.write(`resolved: ${String(target.path ?? '')}\n`)
const readMatches = readBack === '# written by the DSH workspace smoke\n'
process.stdout.write(`read back matches: ${String(readMatches)}\n`)
process.stdout.write(`listed entries: ${entries.map(entry => entry.name).join(',')}\n`)
const diskMatches = onDisk.startsWith('# written by the DSH workspace smoke')
process.stdout.write(`on disk matches: ${String(diskMatches)}\n`)

await app.ctx.fiber.dispose()
rmSync(workspace, { recursive: true, force: true })
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!readMatches || !diskMatches) process.exitCode = 1
