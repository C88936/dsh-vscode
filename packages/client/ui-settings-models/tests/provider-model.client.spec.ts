/**
 * The carrier hook reader: a page without the hook offers no save, and the
 * carrier's answer is validated before the page reports the model as saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerModelSaver } from '../src/client/provider-model.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Install the page transport with one carrier hook value. */
function transportWith(hook: unknown): void {
  vi.stubGlobal('__DSH_TRANSPORT__', { setProviderModel: hook })
}

describe('providerModelSaver', () => {
  it('returns undefined when the page transport carries no hook', () => {
    expect(providerModelSaver()).toBeUndefined()
    transportWith(undefined)
    expect(providerModelSaver()).toBeUndefined()
    transportWith('not a function')
    expect(providerModelSaver()).toBeUndefined()
  })

  it('reports saved when the carrier resolves without a value', async () => {
    const hook = vi.fn(async () => {})
    transportWith(hook)
    const save = providerModelSaver()
    expect(save).toBeDefined()
    expect(await save?.('company-model')).toEqual({ kind: 'saved' })
    expect(hook).toHaveBeenCalledExactlyOnceWith('company-model')
  })

  it('reads an explicit success or refusal answer', async () => {
    transportWith(async () => ({ ok: true }))
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'saved' })
    transportWith(async () => ({ ok: false, error: 'not allowed' }))
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: 'not allowed' })
    transportWith(async () => ({ ok: false }))
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: '' })
  })

  it('fails an unreadable answer instead of reporting the model as saved', async () => {
    transportWith(async () => 'saved')
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: '' })
    transportWith(async () => null)
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: '' })
    transportWith(async () => ({ unexpected: true }))
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: '' })
  })

  it('reports a rejected carrier answer as a failure with its message', async () => {
    transportWith(async () => { throw new Error('the host refused the save') })
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: 'the host refused the save' })
    transportWith(async () => { throw 'plain text' })
    expect(await providerModelSaver()?.('m')).toEqual({ kind: 'failed', detail: 'plain text' })
  })
})
