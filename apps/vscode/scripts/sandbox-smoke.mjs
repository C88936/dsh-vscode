/**
 * Verify the installed companion's Windows workspace-write sandbox through the
 * built runtime, without loading source files through tsx.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionPath = join(here, '..')
const script = join(extensionPath, 'lib', 'companion.cjs')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-sandbox-companion-'))
const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-sandbox-workspace-'))
const options = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: join(extensionPath, '..', '..', 'apps', 'web', 'dist'),
  cwd: workspace,
  workspacePath: workspace,
}

const child = spawn(process.execPath, [script, JSON.stringify(options)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_HOME: join(storageDir, 'home'),
    DSH_VSCODE_SHELL_BACKEND: 'local',
    DSH_VSCODE_SANDBOX_SMOKE: '1',
    WINDOWS_JOB_DEBUG: '1',
  },
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
const lines = createInterface({ input: child.stdout })
const childExit = new Promise(resolve => { child.on('exit', resolve) })
const completed = Promise.withResolvers()
let failed = false

lines.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.stderr.write(`${line}\n`)
    return
  }
  if (frame.type === 'ready') {
    process.stdout.write(`ready: ${String(frame.payload.injections.length)} injections\n`)
    return
  }
  if (frame.type === 'fatal') {
    process.stdout.write(`fatal: ${frame.message}\n`)
    failed = true
    completed.resolve()
    return
  }
  if (frame.type !== 'log') return
  process.stderr.write(`[companion] ${frame.line}\n`)
  if (frame.line.startsWith('dsh: sandbox smoke exit=')) {
    failed = !/exit=0 output=sandbox-ok/u.test(frame.line)
    completed.resolve()
  } else if (frame.line.startsWith('dsh: sandbox smoke failed:')) {
    failed = true
    completed.resolve()
  }
})

const timeout = setTimeout(() => {
  process.stdout.write('sandbox smoke timeout\n')
  failed = true
  completed.resolve()
}, 30_000)
await completed.promise
clearTimeout(timeout)
child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
child.stdin.end()
const exitTimeout = setTimeout(() => {
  process.stdout.write('companion did not exit after shutdown\n')
  failed = true
  child.kill()
}, 10_000)
await childExit
clearTimeout(exitTimeout)
rmSync(workspace, { recursive: true, force: true })
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write(`sandbox smoke success: ${String(!failed)}\n`)
if (failed) process.exitCode = 1
