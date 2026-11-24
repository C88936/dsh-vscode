/**
 * Drive one real DSH turn end to end without a provider key.
 *
 * Starts the repository's Messages-compatible mock server, boots the same
 * composition the extension boots, asks the agent to read a file, and asserts
 * that the tool ran, the answer came back, and the session persisted.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '../../../packages/test-support/llm-mock-server/src/index.ts'
import { createUserMessage } from '../../../packages/llm/llm/src/index.ts'
import { bootDsh } from '../src/host/boot.ts'

interface AgentHandleLike {
  readonly agent: {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    readonly session: { readonly id: string }
  }
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
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-turn-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-turn-'))
const target = join(workspace, 'hello.txt')
writeFileSync(target, 'hello from the vscode turn smoke\n')

const server = await startMockLlmServer({
  port: 0,
  sequence: ['tool_call_success', 'success', 'success'],
  repeatLast: true,
  successText: 'The file content is hello from the vscode turn smoke.',
  toolName: 'read',
  toolArguments: JSON.stringify({ path: target }),
})
process.env.DEEPSEEK_BASE_URL = `${server.baseURL}/v1`
process.env.DEEPSEEK_API_KEY = 'mock-key'

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  log: (line) => { process.stderr.write(`${line}\n`) },
})

const agents = app.ctx.get('agents') as AgentsLike | undefined
if (agents === undefined) throw new Error('agents service is missing')

const sessionId = `smoke-${Date.now().toString(36)}`
const seen: string[] = []
const sessionsRoot = join(process.env.DSH_HOME, 'sessions')
const countSessions = (): number => {
  if (!existsSync(sessionsRoot)) return 0
  const walk = (dir: string): number => readdirSync(dir).reduce((total, name) => {
    const path = join(dir, name)
    return total + (statSync(path).isDirectory() ? walk(path) : 1)
  }, 0)
  return readdirSync(sessionsRoot).length === 0 ? 0 : walk(sessionsRoot)
}
const before = countSessions()
app.ctx.on('session/event', (...args: unknown[]) => {
  const event = args[1] as { type?: string } | undefined
  if (event?.type !== undefined) seen.push(event.type)
})
// The product path composes a preset in the agent's setup; the bare core API
// does not, so mounting here is what gives the model its file and shell tools.
const presets = app.ctx.get('agentPresets') as {
  mount(agentCtx: unknown, id: string): Promise<void>
} | undefined
if (presets === undefined) throw new Error('agent preset service is missing')
const handle = await agents.create({
  sessionId,
  meta: { agentPreset: 'standard' },
  setup: async (agentCtx: unknown) => { await presets.mount(agentCtx, 'standard') },
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
})
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: `Read the file ${target} and report its content.` }],
  source: { kind: 'user' },
}))
await handle.agent.whenIdle()

process.stdout.write(`requests: ${String(server.requests.length)}\n`)
for (const record of server.requests.slice(0, 4)) {
  const body = record.body as { model?: string; messages?: unknown[]; tools?: unknown[] } | undefined
  process.stdout.write(`  #${String(record.attempt)} ${record.behavior} model=${String(body?.model)} messages=${String(body?.messages?.length)} tools=${String(body?.tools?.length)}\n`)
  const messages = body?.messages ?? []
  const last = messages[messages.length - 1]
  process.stdout.write(`    last=${JSON.stringify(last).slice(0, 400)}\n`)
  const tools = (body?.tools ?? []) as { name?: string }[]
  process.stdout.write(`    tools=${tools.map(tool => String(tool.name)).join(',')}\n`)
}
const secondText = JSON.stringify(server.requests.map(record => record.body))
const toolResultFedBack = secondText.includes('tool_result')
const turnClosed = seen.includes('turn/end')
const toolResultEvent = seen.includes('tool/result')
const assistantMessageEvent = seen.includes('assistant/message')
const persisted = countSessions() > before
process.stdout.write(`tool result fed back: ${String(toolResultFedBack)}\n`)

process.stdout.write(`session events: ${[...new Set(seen)].join(',')}\n`)
process.stdout.write(`turn closed: ${String(turnClosed)}\n`)
process.stdout.write(`tool result event: ${String(toolResultEvent)}\n`)
process.stdout.write(`assistant message event: ${String(assistantMessageEvent)}\n`)
process.stdout.write(`sessions persisted: ${String(persisted)} (${String(before)} -> ${String(countSessions())})\n`)

await handle.dispose()
await app.ctx.fiber.dispose()
await server.close()
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!toolResultFedBack || !turnClosed || !toolResultEvent || !assistantMessageEvent || !persisted) {
  process.exitCode = 1
}
