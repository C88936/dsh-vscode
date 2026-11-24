/**
 * Verify that a VS Code-stored secret reaches the DSH provider.
 *
 * The mock server accepts exactly one key, so a turn that completes proves the
 * value travelled from `SecretStorage` through `credentialEnv()` into the
 * launch environment the adapter reads.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '../../../packages/test-support/llm-mock-server/src/index.ts'
import { createUserMessage } from '../../../packages/llm/llm/src/index.ts'
import { bootDsh } from '../src/host/boot.ts'
import { credentialEnv } from '../src/host/env.ts'

interface AgentHandleLike {
  readonly agent: { followup(message: unknown): void; whenIdle(): Promise<void> }
  dispose(): Promise<void>
}

interface AgentsLike {
  create(options: { sessionId: string; agentOptions: { provider: string; model: string } }): Promise<AgentHandleLike>
}

/** A key that only exists in this process, standing in for SecretStorage. */
const SECRET = 'stored-in-secret-storage-123'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-secret-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const server = await startMockLlmServer({
  port: 0,
  apiKey: SECRET,
  sequence: ['success'],
  repeatLast: true,
  successText: 'the stored key works',
})

// Exactly the values the extension hands to the application.
Object.assign(process.env, credentialEnv({ apiKey: SECRET, baseUrl: `${server.baseURL}/v1` }))

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  log: line => { process.stderr.write(`${line}\n`) },
})

const seen: string[] = []
app.ctx.on('session/event', (...args: unknown[]) => {
  const event = args[1] as { type?: string } | undefined
  if (event?.type !== undefined) seen.push(event.type)
})

const agents = app.ctx.get('agents') as AgentsLike | undefined
if (agents === undefined) throw new Error('agents service is missing')
const handle = await agents.create({
  sessionId: `secret-${Date.now().toString(36)}`,
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
})
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Reply with anything.' }],
  source: { kind: 'user' },
}))
await handle.agent.whenIdle()

const sentKey = server.requests[0]?.headers['x-api-key']
process.stdout.write(`requests: ${String(server.requests.length)}\n`)
const keyReached = sentKey === SECRET
const answered = seen.includes('assistant/message')
const closed = seen.includes('turn/end')
process.stdout.write(`api key reached the provider: ${String(keyReached)}\n`)
process.stdout.write(`assistant answered: ${String(answered)}\n`)
process.stdout.write(`turn closed: ${String(closed)}\n`)

await handle.dispose()
await app.ctx.fiber.dispose()
await server.close()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!keyReached || !answered || !closed) process.exitCode = 1
