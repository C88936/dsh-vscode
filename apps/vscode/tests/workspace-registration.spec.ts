/** Workspace initialization preserves existing Sessions and joins concurrent window attaches. */
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceRegistration } from '../src/host/workspace-registration.ts'

function fixture(members: string[] = []) {
  const workspace = { id: 'workspace-a', sessionIds: members }
  const create = vi.fn(async (_path: string) => workspace)
  const createSession = vi.fn(async (_request: { workspaceId: string }) => {
    members.push('session-a')
    return { sessionId: 'session-a' }
  })
  const log = vi.fn()
  const ctx = {
    get: (name: string) => name === 'workspaceRegistry' ? { create }
      : name === 'sessionController' ? { create: createSession } : undefined,
  }
  return { registration: new WorkspaceRegistration(ctx as never, log), create, createSession, log, workspace }
}

describe('WorkspaceRegistration', () => {
  it('seeds an empty folder through the registered Workspace identity', async () => {
    const f = fixture()
    await f.registration.ensure('E:/work/a')
    expect(f.create).toHaveBeenCalledWith('E:/work/a')
    expect(f.createSession).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-a' })
    expect(f.log).toHaveBeenCalledWith('dsh: created blank VS Code workspace session session-a')
  })

  it('joins concurrent aliases of one Workspace instead of creating duplicate blank Sessions', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { finish = resolve })
    f.createSession.mockImplementation(async () => {
      await ready
      f.workspace.sessionIds.push('session-a')
      return { sessionId: 'session-a' }
    })
    const first = f.registration.ensure('E:/work/a')
    const second = f.registration.ensure('E:/work/a/.')
    await vi.waitFor(() => { expect(f.createSession).toHaveBeenCalledTimes(1) })
    finish?.()
    await Promise.all([first, second])
    await f.registration.ensure('E:/work/a')
    expect(f.workspace.sessionIds).toEqual(['session-a'])
    expect(f.createSession).toHaveBeenCalledTimes(1)
  })

  it('keeps existing membership without recreating or rebinding Sessions', async () => {
    const members = ['old-session']
    const f = fixture(members)
    await f.registration.ensure('E:/work/a')
    expect(f.createSession).not.toHaveBeenCalled()
    expect(members).toEqual(['old-session'])
  })

  it('initializes different Workspaces independently', async () => {
    const f = fixture()
    const second = { id: 'workspace-b', sessionIds: [] as string[] }
    f.create.mockImplementation(async path => path === 'E:/work/b' ? second : f.workspace)
    await Promise.all([f.registration.ensure('E:/work/a'), f.registration.ensure('E:/work/b')])
    expect(f.createSession.mock.calls.map(([request]) => request.workspaceId).sort())
      .toEqual(['workspace-a', 'workspace-b'])
  })

  it('reports a failed seed and permits a later attach to retry', async () => {
    const f = fixture()
    f.createSession.mockRejectedValueOnce(new Error('session storage failed'))
    await expect(f.registration.ensure('E:/work/a')).rejects.toThrow('session storage failed')
    expect(f.log).not.toHaveBeenCalled()
    await f.registration.ensure('E:/work/a')
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.workspace.sessionIds).toEqual(['session-a'])
  })

  it('propagates invalid directory failures before creating a Session', async () => {
    const f = fixture()
    f.create.mockRejectedValueOnce(new Error('path is not a directory'))
    await expect(f.registration.ensure('E:/work/missing')).rejects.toThrow('path is not a directory')
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.log).not.toHaveBeenCalled()
  })
})
