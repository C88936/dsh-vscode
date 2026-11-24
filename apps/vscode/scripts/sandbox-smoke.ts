/**
 * Verify the default Windows sandbox can execute a write-capable workspace
 * command without falling back to unconfined execution.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'

interface ShellExecutionLike {
  result(): Promise<{
    exitCode: number | null
    stdout: { text: string }
    stderr: { text: string }
  }>
}

interface ShellLike {
  execute(request: {
    command: string
    workdir: string
    sandboxPolicy: { mode: 'workspace-write'; workspaceRoot: string }
  }): Promise<ShellExecutionLike>
}

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-sandbox-storage-'))
const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-sandbox-workspace-'))
process.env.DSH_HOME = join(storageDir, 'home')
writeFileSync(join(workspace, 'proof.txt'), 'before\n')

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  cwd: workspace,
  log: line => { process.stderr.write(`${line}\n`) },
})
const shell = app.ctx.get('shell') as ShellLike | undefined
if (shell === undefined) throw new Error('ctx.shell is missing')

let ok = false
try {
  const execution = await shell.execute({
    command: "Set-Content -LiteralPath './proof.txt' -Value 'after'; Get-Content -LiteralPath './proof.txt'",
    workdir: workspace,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
  })
  const result = await execution.result()
  process.stdout.write(`sandbox exit: ${String(result.exitCode)}\n`)
  process.stdout.write(`sandbox stdout: ${result.stdout.text.trim()}\n`)
  process.stdout.write(`sandbox stderr: ${result.stderr.text.trim()}\n`)
  ok = result.exitCode === 0 && result.stdout.text.includes('after')
} catch (error) {
  process.stderr.write(`sandbox failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
}

await app.ctx.fiber.dispose()
rmSync(workspace, { recursive: true, force: true })
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!ok) process.exitCode = 1
