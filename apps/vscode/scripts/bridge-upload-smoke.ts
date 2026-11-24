/**
 * Verify one browser-style binary upload through the Webview bridge into the
 * DSH file-upload service.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'
import { WebviewBridge, type WebviewHost } from '../src/host/bridge.ts'

interface AgentHandleLike {
  dispose(): Promise<void>
}

interface AgentsLike {
  create(options: {
    sessionId: string
    agentOptions: { provider: string; model: string }
  }): Promise<AgentHandleLike>
}

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-upload-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  log: line => { process.stderr.write(`${line}\n`) },
})
const agents = app.ctx.get('agents') as AgentsLike | undefined
if (agents === undefined) throw new Error('ctx.agents is missing')
const sessionId = `upload-${Date.now().toString(36)}`
const handle = await agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
})

const frames: unknown[] = []
const host: WebviewHost = {
  asUri: path => path,
  postMessage: async (message) => { frames.push(message) },
}
const bridge = new WebviewBridge(app.ctx, storageDir, host, line => { process.stderr.write(`${line}\n`) })
const uploadId = 41
await bridge.handle({
  type: 'upload-open',
  id: uploadId,
  url: `api/session/uploadFileBinary?sessionId=${sessionId}&name=audit.txt`,
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
})
await bridge.handle({
  type: 'upload-chunk',
  id: uploadId,
  seq: 1,
  data: Buffer.from('bridge upload body', 'utf8').toString('base64'),
})
await bridge.handle({ type: 'upload-end', id: uploadId, seq: 2 })

let result: { status?: number; body?: string } | undefined
for (let attempt = 0; attempt < 300 && result === undefined; attempt++) {
  result = frames.find((frame): frame is { status: number; body: string } => (
    typeof frame === 'object'
    && frame !== null
    && 'type' in frame
    && frame.type === 'upload-result'
    && 'id' in frame
    && frame.id === uploadId
  ))
  if (result === undefined) await new Promise(resolve => setTimeout(resolve, 10))
}
if (result === undefined) throw new Error('upload response did not arrive')
const parsed = JSON.parse(result.body ?? '{}') as { ok?: unknown; value?: unknown }
const ok = result.status === 200 && parsed.ok === true
process.stdout.write(`upload status: ${String(result.status)}\n`)
process.stdout.write(`upload body: ${(result.body ?? '').slice(0, 400)}\n`)
process.stdout.write(`upload business success: ${String(ok)}\n`)

bridge.dispose()
await handle.dispose()
await app.ctx.fiber.dispose()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!ok) process.exitCode = 1
