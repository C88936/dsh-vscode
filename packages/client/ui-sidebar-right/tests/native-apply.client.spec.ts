/**
 * Native composition of the sidebar: the carrier's editor replaces the page
 * surface, so no seats register and navigation resolves into the host hook.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'

const SESSION = 's-test' as SessionId

async function boot(openResource: (request: { address: string; path?: string; line?: number }) => void | Promise<void>) {
  vi.stubGlobal('__DSH_TRANSPORT__', { openResource })
  const ctx = new Context()
  const registered: unknown[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => ctx.effect(register)),
    register: vi.fn((options: unknown) => {
      registered.push(options)
      return () => {}
    }),
  }
  const layout = {
    openRightbar: vi.fn(), closeRightbar: vi.fn(),
    panelInfo: createSnapshotStore<{ activePanelId: string | null }>({ activePanelId: null }),
  }
  const current = createSnapshotStore<{ key: SessionId | undefined }>({ key: SESSION })
  const list = createSnapshotStore({
    byId: {
      [SESSION]: { cwd: 'C:\\work' },
      's-two': { cwd: 'C:\\other' },
    },
  })
  ctx.provide('slots', slots as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: () => () => {},
  } as never)
  ctx.provide('shortcuts', {
    runtime: 'web', register: () => () => {},
    catalog: { getSnapshot: () => [], subscribe: () => () => {} },
  } as never)
  ctx.provide('layout', layout as never)
  ctx.provide('resources', { pin: vi.fn(() => () => {}) } as never)
  ctx.provide('sessions', { list, retain: vi.fn(() => ({ ready: Promise.resolve(), release: vi.fn() })) } as never)
  ctx.provide('uiSession', { adapter: { current } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })
  return { ctx, registered, slots }
}

describe('ui-sidebar-right native composition', () => {
  it('registers no seat and opens a file at the requested line', async () => {
    const openResource = vi.fn()
    const h = await boot(openResource)
    expect(h.registered).toEqual([])
    expect(h.slots.inject).not.toHaveBeenCalled()
    h.ctx.sidebarRight.openResource(
      'dsh-resource://file/session/s-test/docs/a%20b.txt',
      { params: { line: 7 } },
    )
    expect(openResource).toHaveBeenCalledExactlyOnceWith({
      address: 'dsh-resource://file/session/s-test/docs/a%20b.txt',
      path: 'C:\\work\\docs/a b.txt',
      line: 7,
    })
  })

  it('opens from a named Session rather than the on-screen one', async () => {
    const openResource = vi.fn()
    const h = await boot(openResource)
    h.ctx.sidebarRight.openResourceIn('s-two' as SessionId, 'dsh-resource://file/session/s-two/b.txt')
    expect(openResource).toHaveBeenCalledExactlyOnceWith({
      address: 'dsh-resource://file/session/s-two/b.txt',
      path: 'C:\\other\\b.txt',
    })
  })

  it('reports an unsupported page kind instead of opening a column', async () => {
    const h = await boot(vi.fn())
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    h.ctx.sidebarRight.openTab('browser')
    h.ctx.sidebarRight.openTabIn(SESSION, 'browser')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toMatch(/browser/u)
    h.ctx.sidebarRight.toggleExpanded()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('contains a failing carrier open', async () => {
    const h = await boot(async () => { throw new Error('editor unavailable') })
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    h.ctx.sidebarRight.openResource('dsh-resource://file/absolute/C:/a.txt')
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toMatch(/editor unavailable/u)
  })
})
