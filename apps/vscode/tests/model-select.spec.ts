/**
 * Company model discovery and selection: the `/models` parser, the endpoint call,
 * and the selection flow that saves one model and offers the restart.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchCompanyModels, parseModelIds, selectCompanyModel } from '../src/host/model-select.ts'

/** A fetch double that records calls and returns one canned response. */
function response(body: unknown, status = 200): typeof fetch {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    void input
    void init
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as typeof fetch
}

describe('parseModelIds', () => {
  it('reads the OpenAI data shape and a bare id list, deduped and sorted', () => {
    expect(parseModelIds({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { id: '  ' }] })).toEqual(['a-model', 'b-model'])
    expect(parseModelIds(['z', ' y ', 'z', ''])).toEqual(['y', 'z'])
  })

  it('returns nothing for an unusable payload', () => {
    expect(parseModelIds({ data: 'nope' })).toEqual([])
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({})).toEqual([])
  })
})

describe('fetchCompanyModels', () => {
  it('asks <base>/models with the stored key and returns the ids', async () => {
    const calls: { url: string; headers: Record<string, string> | undefined }[] = []
    const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers })
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen-max' }] }) } as Response
    }) as unknown as typeof fetch
    expect(await fetchCompanyModels('http://llm.lan:8000/v1/', 'secret', impl)).toEqual(['qwen-max'])
    expect(calls[0]?.url).toBe('http://llm.lan:8000/v1/models')
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer secret' })
  })

  it('reports an unreachable endpoint, a rejected status, bad JSON, and an empty list', async () => {
    await expect(fetchCompanyModels('http://llm.lan/v1', undefined, (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch))
      .rejects.toThrow(/could not be reached \(ECONNREFUSED\)/u)
    await expect(fetchCompanyModels('http://llm.lan/v1', undefined, response({}, 503))).rejects.toThrow(/HTTP 503/u)
    await expect(fetchCompanyModels('http://llm.lan/v1', undefined, (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }) as unknown as typeof fetch)))
      .rejects.toThrow(/did not return JSON/u)
    await expect(fetchCompanyModels('http://llm.lan/v1', undefined, response({ data: [] }))).rejects.toThrow(/listed no model/u)
  })
})

describe('selectCompanyModel', () => {
  it('saves the picked model and reports whether it restarted', async () => {
    const saved: string[] = []
    const logs: string[] = []
    const outcome = await selectCompanyModel({
      baseUrl: 'http://llm.lan/v1',
      readKey: async () => 'secret',
      listModels: async () => ['a-model', 'b-model'],
      currentModel: 'a-model',
      pickModel: async (models, current) => { expect(models).toEqual(['a-model', 'b-model']); expect(current).toBe('a-model'); return 'b-model' },
      saveModel: async (model) => { saved.push(model) },
      confirmRestart: async () => true,
      log: line => { logs.push(line) },
    })
    expect(outcome).toEqual({ status: 'saved', model: 'b-model', restart: true })
    expect(saved).toEqual(['b-model'])
    expect(logs.some(line => line.includes('b-model'))).toBe(true)
  })

  it('leaves the selection untouched when the user cancels', async () => {
    const saveModel = vi.fn(async () => {})
    const outcome = await selectCompanyModel({
      baseUrl: 'http://llm.lan/v1', readKey: async () => undefined,
      listModels: async () => ['a-model'], currentModel: '', pickModel: async () => undefined,
      saveModel, confirmRestart: async () => true, log: () => {},
    })
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(saveModel).not.toHaveBeenCalled()
  })

  it('reports why the endpoint could not be listed or the selection saved', async () => {
    const failedList = await selectCompanyModel({
      baseUrl: 'http://llm.lan/v1', readKey: async () => undefined,
      listModels: async () => { throw new Error('the endpoint listed no model') },
      currentModel: '', pickModel: async () => undefined, saveModel: async () => {},
      confirmRestart: async () => false, log: () => {},
    })
    expect(failedList).toMatchObject({ status: 'failed', diagnostic: expect.stringContaining('listed no model') })

    const failedSave = await selectCompanyModel({
      baseUrl: 'http://llm.lan/v1', readKey: async () => undefined,
      listModels: async () => ['a-model'], currentModel: '', pickModel: async () => 'a-model',
      saveModel: async () => { throw new Error('read-only settings') },
      confirmRestart: async () => false, log: () => {},
    })
    expect(failedSave).toMatchObject({ status: 'failed', diagnostic: expect.stringContaining('read-only settings') })
  })
})
