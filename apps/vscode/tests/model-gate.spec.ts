/**
 * Placeholder inference gate: the module the provider overlay inserts refuses a
 * request for the unconfigured model id instead of sending it to the endpoint.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_GATE_SOURCE, writeModelGate } from '../src/host/model-gate.ts'

type GateListener = (
  options: { model: string },
  next: () => AsyncIterable<string>,
) => AsyncIterable<string>

/** The plugin module the gate source evaluates to. */
interface GateModule {
  readonly name: string
  apply(ctx: { on(event: 'llm/stream', listener: GateListener): () => void }, config: { model: string }): void
}

/**
 * Evaluate the generated module the way the Loader receives it.
 * @returns the plugin module.
 */
async function loadGate(): Promise<GateModule> {
  const url = `data:text/javascript,${encodeURIComponent(MODEL_GATE_SOURCE)}`
  return await import(/* @vite-ignore */ url) as GateModule
}

/**
 * @returns the listeners the plugin registered, and its context double.
 */
function harness(): { ctx: { on(event: 'llm/stream', listener: GateListener): () => void }; listeners: GateListener[] } {
  const listeners: GateListener[] = []
  return {
    listeners,
    ctx: {
      on: (_event, listener) => {
        listeners.push(listener)
        return () => {}
      },
    },
  }
}

describe('placeholder inference gate', () => {
  it('names itself and refuses a stream request for the placeholder', async () => {
    const plugin = await loadGate()
    expect(plugin.name).toBe('company-unconfigured-model-gate')
    const { ctx, listeners } = harness()
    plugin.apply(ctx, { model: 'dsh-unconfigured-model' })
    expect(listeners).toHaveLength(1)

    expect(() => listeners[0]?.({
      model: 'dsh-unconfigured-model',
    }, () => (async function* unexpected() { yield 'the endpoint was asked' })()))
      .toThrow(/no model selected for the company endpoint.*Open Models, fetch the available models, and choose one/u)
  })

  it('delegates every other model to the next listener', async () => {
    const plugin = await loadGate()
    const { ctx, listeners } = harness()
    plugin.apply(ctx, { model: 'dsh-unconfigured-model' })
    const delegated = (async function* chunks() { yield 'answer' })()
    const stream = listeners[0]?.({ model: 'company-model' }, () => delegated)
    expect(stream).toBe(delegated)
  })

  it('writes the module it was built from into the launch directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-model-gate-'))
    try {
      const path = writeModelGate(directory)
      expect(path).toBe(join(directory, 'model-gate.mjs'))
      expect(readFileSync(path, 'utf8')).toBe(MODEL_GATE_SOURCE)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
