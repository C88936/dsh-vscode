/**
 * The company route end to end without a GUI: a mock OpenAI-compatible gateway serves discovery and completion, the
 * effective setting is written through the same helper the commands use, the provider overlay is regenerated from
 * that value, and a restart then reaches the endpoint with the selected model.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  /** Layer values `inspect` reports, keyed by setting name. */
  layers: {} as Record<string, { workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined>,
  /** Values the fake configuration reads back. */
  values: {} as Record<string, unknown>,
  /** Writes the helper performed, in order. */
  updated: [] as { key: string; value: unknown; target: unknown }[],
  /** The failure an update reports instead of saving. */
  updateFailure: '',
}))

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => native.layers[key],
      get: (key: string) => native.values[key],
      update: async (key: string, value: unknown, target: unknown) => {
        if (native.updateFailure !== '') throw new Error(native.updateFailure)
        native.updated.push({ key, value, target })
        native.values[key] = value
      },
    }),
  },
}))

import { bootDsh } from '../src/host/boot.ts'
import { writeEffectiveSetting } from '../src/host/configuration.ts'
import { writeModelGate } from '../src/host/model-gate.ts'
import { providerPatch } from '../src/host/provider.ts'
import { UNCONFIGURED_MODEL_ID } from '../src/host/settings.ts'

interface AgentHandleLike {
  readonly agent: { followup(message: unknown): void; whenIdle(): Promise<void> }
  dispose(): Promise<void>
}

interface AgentsLike {
  create(options: { sessionId: string; agentOptions: { provider: string; model: string } }): Promise<AgentHandleLike>
}

/** One mock company gateway: model discovery plus one streamed completion. */
interface Gateway {
  readonly baseUrl: string
  /** Request lines the gateway received, in order. */
  readonly requests: string[]
  /** Completion request bodies, decoded. */
  readonly completions: { model?: string }[]
  close(): Promise<void>
}

/**
 * Start the mock gateway.
 * @returns the listening gateway.
 */
async function gateway(): Promise<Gateway> {
  const requests: string[] = []
  const completions: { model?: string }[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'listed-model' }] }))
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
        completions.push(JSON.parse(raw) as { model?: string })
      } catch {
        completions.push({})
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'listed-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.write(chunk({ role: 'assistant', content: 'company route answer' }, null))
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock gateway has no port')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    completions,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

const roots: string[] = []
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  native.layers = {}
  native.values = {}
  native.updated.length = 0
  native.updateFailure = ''
})

const extensionPath = join(import.meta.dirname, '..')

/**
 * Boot the composition with one generated provider overlay.
 * @param storageDir - isolated storage for the launch.
 * @param patch - provider overlay text.
 * @returns the live application.
 */
async function boot(storageDir: string, patch: string): Promise<Awaited<ReturnType<typeof bootDsh>>> {
  const patchPath = join(storageDir, 'provider.patch.yml')
  writeFileSync(patchPath, patch)
  process.env.DSH_HOME = join(storageDir, 'home')
  process.env.DSH_LLM_API_KEY = 'company-test-key'
  const app = await bootDsh({
    extensionPath,
    storageDir,
    overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
    extraOverlays: [patchPath],
    log: () => {},
  })
  disposers.push(async () => { await app.ctx.fiber.dispose() })
  return app
}

describe('company route integration', () => {
  it('discovers, saves, and reaches the endpoint with the selected model after a restart', { timeout: 120_000 }, async () => {
    const mock = await gateway()
    try {
      const storageDir = mkdtempSync(join(tmpdir(), 'dsh-company-route-'))
      roots.push(storageDir)
      const first = await boot(storageDir, providerPatch({
        mode: 'openai-compatible',
        route: 'company',
        baseUrl: mock.baseUrl,
        model: '',
        apiKeyEnv: 'DSH_LLM_API_KEY',
      }, { module: pathToFileURL(writeModelGate(storageDir)).href, model: UNCONFIGURED_MODEL_ID }) ?? '')

      // Discovery asks the mock gateway and returns its candidates; nothing is auto-selected.
      const llm = first.ctx.get('llm') as {
        discoverModels(settingsNs: string, request: object, signal?: AbortSignal): Promise<{ id: string }[]>
      } | undefined
      if (llm === undefined) throw new Error('llm service is missing')
      const candidates = await llm.discoverModels('llm-pi-ai', { baseURL: mock.baseUrl, api: 'openai-completions', apiKey: 'company-test-key' })
      process.stdout.write(`step: discovery ${JSON.stringify(candidates)}\n`)
      expect(candidates.map(candidate => candidate.id)).toEqual(['listed-model'])
      expect(mock.requests).toContain('GET /v1/models')
      // The placeholder is refused before the user chooses, so no completion was attempted.
      expect(mock.completions).toEqual([])
      expect(native.values.llmModel).toBeUndefined()

      // The explicit choice is written where the runtime reads it.
      await writeEffectiveSetting('llmModel', candidates[0]?.id ?? '')
      expect(native.values.llmModel).toBe('listed-model')
      await first.ctx.fiber.dispose()
      disposers.length = 0

      // The regenerated overlay names that value, and the restarted composition reaches the endpoint with it.
      const second = await boot(storageDir, providerPatch({
        mode: 'openai-compatible',
        route: 'company',
        baseUrl: mock.baseUrl,
        model: String(native.values.llmModel),
        apiKeyEnv: 'DSH_LLM_API_KEY',
      }) ?? '')
      const agents = second.ctx.get('agents') as AgentsLike | undefined
      if (agents === undefined) throw new Error('agents service is missing')
      const seen: string[] = []
      second.ctx.on('session/event', (...args: unknown[]) => {
        const event = args[1] as { type?: string } | undefined
        if (event?.type !== undefined) seen.push(event.type)
      })
      const handle = await agents.create({
        sessionId: `company-route-${Date.now().toString(36)}`,
        agentOptions: { provider: 'company', model: 'listed-model' },
      })
      handle.agent.followup({
        content: [{ type: 'text', text: 'Answer with the route name.' }],
        source: { kind: 'user' },
      })
      await handle.agent.whenIdle()
      expect(seen).toContain('assistant/message')
      expect(mock.completions.at(-1)?.model).toBe('listed-model')
      await handle.dispose()
    } finally {
      await mock.close()
    }
  })
})
