/**
 * Boot DSH with the VS Code terminal provider and stub runner, without VS Code.
 *
 * This isolates the provider contract from the extension host: a failure here is
 * the provider or the composition, not the webview or the terminal bridge.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { bootDsh, loadFromAnchor, resolveInstallAnchor } from '../src/host/boot.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-shell-provider-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const anchor = resolveInstallAnchor(extensionPath, join(extensionPath, '..', '..'))
const shell = await loadFromAnchor<{ ShellExecutor: unknown }>(anchor, '@deepseek-ai/dsh-shell')
const globals = globalThis as {
  __DSH_VSCODE_SHELL_BASE__?: unknown
  __DSH_VSCODE_TERMINAL__?: unknown
}
globals.__DSH_VSCODE_SHELL_BASE__ = shell.ShellExecutor
globals.__DSH_VSCODE_TERMINAL__ = {
  run: async (request: { command: string; cwd: string }) => {
    process.stdout.write(`runner: ${request.command} (${request.cwd})\n`)
    return { output: `ran: ${request.command}`, exitCode: 0 }
  },
}

const providerPath = join(extensionPath, 'lib', 'terminal-provider.cjs')
const patchPath = join(storageDir, 'vscode-shell.patch.yml')
writeFileSync(patchPath, [
  '- id: bash-sandbox',
  '  disabled: true',
  '- id: pwsh-sandbox',
  '  disabled: true',
  '- id: permission',
  '  disabled: true',
  '- insert:',
  '    - id: vscode-shell',
  `      name: '${pathToFileURL(providerPath).href}'`,
  '    - id: vscode-editor',
  `      name: '${pathToFileURL(join(extensionPath, 'lib', 'editor-provider.cjs')).href}'`,
  '',
].join('\n'))

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  extraOverlays: [patchPath],
  cwd: process.cwd(),
  log: line => { process.stderr.write(`${line}\n`) },
})

const shellService = app.ctx.get('shell') as {
  execute(request: { command: string; workdir?: string }): Promise<{ result(): Promise<unknown> }>
} | undefined
if (shellService === undefined) throw new Error('ctx.shell is missing')

try {
  const execution = await shellService.execute({ command: 'echo provider-ok', workdir: process.cwd() })
  process.stdout.write(`result: ${JSON.stringify(await execution.result())}\n`)
} catch (error) {
  process.stdout.write(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
}

const agents = app.ctx.get('agents') as {
  create(options: { sessionId: string; agentOptions: { provider: string; model: string } }): Promise<{ agent: unknown; dispose(): Promise<void> }>
} | undefined
const commands = app.ctx.get('commands') as { list(agent: unknown): readonly { name: string }[] } | undefined
if (agents !== undefined && commands !== undefined) {
  const handle = await agents.create({
    sessionId: `cmd-${Date.now().toString(36)}`,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  process.stdout.write(`commands: ${commands.list(handle.agent).map(command => command.name).join(',')}\n`)
  await handle.dispose()
}
await app.ctx.fiber.dispose()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
