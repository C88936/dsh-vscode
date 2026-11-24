/**
 * Verify an OpenAI-compatible private endpoint through the pi-ai adapter.
 *
 * The smoke starts a minimal Chat Completions server, generates the same
 * provider overlay the extension writes for a LAN deployment, boots the
 * composition, and runs one turn against that route.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'
import { providerPatch } from '../src/host/provider.ts'

interface AgentHandleLike {
  readonly agent: { followup(message: unknown): void; whenIdle(): Promise<void> }
  dispose(): Promise<void>
}

interface AgentsLike {
  create(options: { sessionId: string; agentOptions: { provider: string; model: string } }): Promise<AgentHandleLike>
}

/** Request bodies the mock endpoint received. */
const bodies: unknown[] = []

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'company-model' }] }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404)
    response.end()
    return
  }
  let raw = ''
  request.on('data', (chunk) => { raw += String(chunk) })
  request.on('end', () => {
    try {
      bodies.push(JSON.parse(raw))
    } catch {
      bodies.push(raw)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const chunk = (delta: object, finish: string | null): string =>
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'company-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(chunk({ role: 'assistant', content: 'hello from the private endpoint' }, null))
    response.write(chunk({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
})
await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('mock server has no port')
const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-provider-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')
process.env.DSH_LLM_API_KEY = 'lan-key'

const patch = providerPatch({
  mode: 'openai-compatible',
  route: 'company',
  baseUrl,
  model: 'company-model',
  apiKeyEnv: 'DSH_LLM_API_KEY',
})
if (patch === undefined) throw new Error('provider patch was not generated')
const patchPath = join(storageDir, 'provider.patch.yml')
writeFileSync(patchPath, patch)

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  extraOverlays: [patchPath],
  log: line => { process.stderr.write(`${line}\n`) },
})

const agents = app.ctx.get('agents') as AgentsLike | undefined
if (agents === undefined) throw new Error('agents service is missing')
const { createUserMessage } = await import('../../../packages/llm/llm/src/index.ts')

const seen: string[] = []
app.ctx.on('session/event', (...args: unknown[]) => {
  const event = args[1] as { type?: string } | undefined
  if (event?.type !== undefined) seen.push(event.type)
})

const handle = await agents.create({
  sessionId: `openai-${Date.now().toString(36)}`,
  agentOptions: { provider: 'company', model: 'company-model' },
})
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Say hello.' }],
  source: { kind: 'user' },
}))
await handle.agent.whenIdle()

const body = JSON.stringify(bodies[0] ?? {})
process.stdout.write(`requests: ${String(bodies.length)}\n`)
const reached = bodies.length > 0
const carriedPrompt = body.includes('Say hello.')
const answered = seen.includes('assistant/message')
const closed = seen.includes('turn/end')
process.stdout.write(`request url reached the private endpoint: ${String(reached)}\n`)
process.stdout.write(`request carried the user text: ${String(carriedPrompt)}\n`)
process.stdout.write(`assistant answered: ${String(answered)}\n`)
process.stdout.write(`turn closed: ${String(closed)}\n`)

await handle.dispose()
await app.ctx.fiber.dispose()
await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!reached || !carriedPrompt || !answered || !closed) process.exitCode = 1
