/**
 * Exercise the webview bridge without VS Code.
 *
 * Boots the same composition the extension boots, fakes the Webview surface,
 * and verifies the boot payload, the materialized client bundles, and one
 * unary RPC round-trip through the shared Fetch handler.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'
import { WebviewBridge, type WebviewHost } from '../src/host/bridge.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-shell-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  log: line => { process.stderr.write(`${line}\n`) },
})

const frames: unknown[] = []
const host: WebviewHost = {
  asUri: path => `file:///${path.replaceAll('\\', '/')}`,
  postMessage: async (message) => { frames.push(message) },
}
const bridge = new WebviewBridge(app.ctx, storageDir, host, line => { process.stderr.write(`${line}\n`) })
const shellRoot = join(extensionPath, '..', '..', 'apps', 'web', 'dist')
const payload = await bridge.prepare(shellRoot)

process.stdout.write(`injections: ${String(payload.injections.length)}\n`)
process.stdout.write(`shell: ${payload.shell}\n`)
process.stdout.write(`styles: ${String(payload.styles.length)}\n`)
const shellFile = payload.shell.replace('file:///', '').replaceAll('/', '\\')
process.stdout.write(`shell exists: ${String(existsSync(shellFile))}\n`)
const webroot = join(storageDir, 'webview')
process.stdout.write(`materialized files: ${String(existsSync(webroot) ? readdirSync(webroot, { recursive: true }).length : 0)}\n`)

const registry = app.ctx.get('clientModules') as { graph(): { entries: { url: string }[]; batches: { url: string }[] } }
const graph = registry.graph()
for (const entry of graph.entries.slice(0, 3)) process.stdout.write(`entry url: ${entry.url}\n`)
for (const batch of graph.batches) process.stdout.write(`batch url: ${batch.url}\n`)

const rpcId = 'smoke-rpc-id'
const envelope = JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } })
await bridge.handle({ type: 'fetch', id: 1, url: 'api/session/list', body: envelope })
const answer = frames.find(frame => typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'fetch-result') as
  | { status: number; body: string }
  | undefined
process.stdout.write(`rpc status: ${String(answer?.status)}\n`)
process.stdout.write(`rpc body: ${(answer?.body ?? '').slice(0, 300)}\n`)
let businessOk = false
try {
  const response = JSON.parse(answer?.body ?? '') as { result?: { ok?: unknown } }
  businessOk = answer?.status === 200 && response.result?.ok === true
} catch {
  businessOk = false
}
process.stdout.write(`rpc business success: ${String(businessOk)}\n`)

bridge.dispose()
await app.ctx.fiber.dispose()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!businessOk) process.exitCode = 1
