/**
 * Boot the VS Code composition in plain Node.
 *
 * This is the Phase-0 smoke path: it exercises the same `bootDsh` sequence the
 * extension uses, without a VS Code host, and reports which services the tree
 * actually provides.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-boot-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const REPORTED = ['agents', 'sessions', 'tools', 'llm', 'connection', 'clientModules', 'typertGateway', 'shell', 'shellEnv', 'terminals', 'subprocess', 'sandboxPolicy']

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
  log: line => { process.stderr.write(`${line}\n`) },
})

const ctx = app.ctx
const present = REPORTED.filter(key => ctx.get(key) !== undefined)
process.stdout.write(`live services: ${present.join(', ')}\n`)

const modules = ctx.get('clientModules') as { graph(): { entries: unknown[]; batches: unknown[] } } | undefined
if (modules === undefined) throw new Error('clientModules is missing')
const graph = modules.graph()
process.stdout.write(`boot graph: ${String(graph.entries.length)} entries, ${String(graph.batches.length)} batches\n`)
process.stdout.write(`profile: ${app.profileDir}\n`)
process.stdout.write(`anchor: ${app.installAnchor}\n`)

await ctx.fiber.dispose()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
