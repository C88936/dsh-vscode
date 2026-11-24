/**
 * Extension restart: a refusal or a failed boot reaches the caller instead of a
 * fulfilled command, and observed Host work blocks the restart first.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const native = vi.hoisted(() => ({
  errors: [] as string[],
  infos: [] as string[],
  terminals: [] as { name: string }[],
}))

vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, params?: Record<string, string>) => Object.entries(params ?? {})
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), message),
  },
  window: {
    terminals: native.terminals,
    showErrorMessage: (message: string) => { native.errors.push(message); return Promise.resolve(undefined) },
    showInformationMessage: (message: string) => { native.infos.push(message); return Promise.resolve(undefined) },
  },
  commands: { registerCommand: () => ({ dispose: () => {} }) },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
}))

// The restart decision is what this suite covers; the host and view are doubles.
vi.mock('../src/host/host.ts', () => ({
  DshHost: class {},
  describe: (error: unknown) => error instanceof Error ? error.message : String(error),
}))
vi.mock('../src/view/chat-view.ts', () => ({ DshChatView: class {} }))

import { clearedCredentialNotice, restart, restartAfterCredentialChange, RestartActivityMonitor } from '../src/extension.ts'

function idleGuard() {
  return { blockers: () => [] as string[] }
}

function hostDouble(restartHost: () => Promise<void>) {
  return { restart: vi.fn(restartHost) } as never
}

function viewDouble(refresh: () => Promise<void>) {
  return { refresh: vi.fn(refresh), freezeTransport: vi.fn(async () => {}) } as never
}

describe('extension restart', () => {
  it('closes the page transport before stopping the host', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const restartHost = vi.fn(async () => {})
    const freeze = vi.fn(async () => {})
    await restart(
      { restart: restartHost } as never,
      { refresh: vi.fn(async () => {}), freezeTransport: freeze } as never,
      idleGuard(),
      () => {},
      'DSH restarted',
    )
    // Work that starts between the confirmation and the stop is refused by the closed transport, not interrupted.
    expect(freeze).toHaveBeenCalledWith('DSH is restarting')
    expect(freeze.mock.invocationCallOrder[0]).toBeLessThan(restartHost.mock.invocationCallOrder[0]!)
    expect(native.infos).toEqual(['DSH restarted'])
  })
  it('reports a failed host restart to its caller', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const view = viewDouble(async () => {})
    await expect(restart(
      hostDouble(async () => { throw new Error('companion exited during startup') }),
      view, idleGuard(), () => {}, 'DSH restarted',
    )).rejects.toThrow('companion exited during startup')
    expect(native.errors[0]).toContain('DSH restart failed')
    expect(native.infos).toEqual([])
    // The page's transport was closed before the stop, so the failure path restores a live view.
    expect((view as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalledOnce()
  })

  it('reports a view refresh failure after a successful boot', async () => {
    native.errors.length = 0
    native.infos.length = 0
    await expect(restart(
      hostDouble(async () => {}),
      viewDouble(async () => { throw new Error('the shell is missing') }),
      idleGuard(), () => {}, 'DSH restarted',
    )).rejects.toThrow('the chat view could not be refreshed')
    expect(native.errors[0]).toContain('the shell is missing')
    expect(native.infos).toEqual([])
  })

  it('refuses observed running work before touching the host', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const host = hostDouble(async () => {})
    await expect(restart(host, viewDouble(async () => {}), { blockers: () => ['a running turn'] }, () => {}, 'DSH restarted'))
      .rejects.toThrow('a running turn')
    expect((host as { restart: ReturnType<typeof vi.fn> }).restart).not.toHaveBeenCalled()
    expect(native.errors[0]).toContain('cannot restart')
    expect(native.infos).toEqual([])
  })

  it('reports success only after the host and the repaint settle', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const view = viewDouble(async () => {})
    await restart(hostDouble(async () => {}), view, idleGuard(), () => {}, 'DSH restarted')
    expect((view as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalledOnce()
    expect(native.infos).toEqual(['DSH restarted'])
  })
})

describe('credential changes', () => {
  const request = (fields: Partial<Parameters<typeof restartAfterCredentialChange>[0]> = {}) => ({
    dsh: hostDouble(async () => {}),
    view: viewDouble(async () => {}),
    guard: idleGuard(),
    log: () => {},
    subject: 'private endpoint key',
    action: 'stored' as const,
    write: async () => {},
    saved: 'dsh: private endpoint key stored in SecretStorage',
    success: 'DSH restarted with the private endpoint key',
    ...fields,
  })

  it('reports the stored key as saved when the restart fails, not the write', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const write = vi.fn(async () => {})
    await expect(restartAfterCredentialChange(request({
      dsh: hostDouble(async () => { throw new Error('companion exited during startup') }),
      write,
    }))).rejects.toThrow('companion exited during startup')
    expect(write).toHaveBeenCalledOnce()
    expect(native.errors[0]).toContain('the private endpoint key was stored in VS Code SecretStorage')
    expect(native.errors[0]).toContain('the new configuration did not start')
    expect(native.errors[0]).toContain('companion exited during startup')
    expect(native.errors[0]).not.toContain('could not change')
    expect(native.infos).toEqual([])
  })

  it('reports a SecretStorage write failure as that failure and starts no restart', async () => {
    native.errors.length = 0
    native.infos.length = 0
    const host = hostDouble(async () => {})
    await expect(restartAfterCredentialChange(request({
      dsh: host,
      write: async () => { throw new Error('secret storage unavailable') },
    }))).rejects.toThrow('secret storage unavailable')
    expect(native.errors[0]).toContain('could not change the private endpoint key in VS Code SecretStorage')
    expect(native.errors[0]).toContain('secret storage unavailable')
    expect((host as { restart: ReturnType<typeof vi.fn> }).restart).not.toHaveBeenCalled()
    expect(native.infos).toEqual([])
  })

  it('states that only the SecretStorage item was removed and leaves other sources unchecked', () => {
    const message = clearedCredentialNotice('private endpoint key')
    expect(message).toContain('clearing the private endpoint key from VS Code SecretStorage')
    expect(message).toContain('A managed credential, an environment value, or a .env file may still resolve the route')
    expect(message).toContain('did not check those sources')
    expect(message).not.toContain('managed credential still resolves')
  })

  it('reports the removed key as removed when the restart fails and shows the notice after success', async () => {
    native.errors.length = 0
    native.infos.length = 0
    await expect(restartAfterCredentialChange(request({
      dsh: hostDouble(async () => { throw new Error('start refused') }),
      action: 'removed',
      write: async () => {},
      success: clearedCredentialNotice('private endpoint key'),
    }))).rejects.toThrow('start refused')
    expect(native.errors[0]).toContain('the private endpoint key was removed in VS Code SecretStorage')
    expect(native.errors[0]).toContain('the new configuration did not start')
    native.errors.length = 0
    await restartAfterCredentialChange(request({
      action: 'removed',
      success: clearedCredentialNotice('private endpoint key'),
    }))
    expect(native.infos).toEqual([clearedCredentialNotice('private endpoint key')])
    expect(native.errors).toEqual([])
  })
})

describe('RestartActivityMonitor', () => {
  it('counts running turns, live terminals, and manager operations, and releases its watch', async () => {
    const listeners: ((operation: { id: string; phase: string }) => void)[] = []
    const context = {
      get: (name: string) => name === 'agents'
        ? { list: () => [{ status: 'running' }, { status: 'idle' }] }
        : { list: () => [{ status: { kind: 'running' } }] },
      on: (_event: 'plugin-manager/operation', listener: (operation: { id: string; phase: string }) => void) => {
        listeners.push(listener)
        return () => { listeners.length = 0 }
      },
    }
    native.terminals.length = 0
    native.terminals.push({ name: 'DSH' })
    const monitor = new RestartActivityMonitor(() => context, () => native.terminals)
    onTestFinished(() => { monitor.dispose() })

    expect(await monitor.activity()).toEqual({ runningTurns: 1, packageOperations: 0, runningTerminals: 3 })
    expect(await monitor.blockers()).toEqual(['a running turn', 'a running DSH terminal command'])

    listeners[0]?.({ id: 'operation-1', phase: 'started' })
    expect(await monitor.blockers()).toContain('a running package operation')

    listeners[0]?.({ id: 'operation-1', phase: 'settled' })
    expect(await monitor.blockers()).not.toContain('a running package operation')

    monitor.dispose()
    expect(listeners).toEqual([])
  })

  it('reports the work a companion answers for, plus the integrated DSH terminal', async () => {
    native.terminals.length = 0
    native.terminals.push({ name: 'DSH' }, { name: 'other' })
    const monitor = new RestartActivityMonitor(
      () => undefined,
      () => native.terminals,
      async () => ({ runningTurns: 1, packageOperations: 0, runningTerminals: 2 }),
    )
    onTestFinished(() => { monitor.dispose() })

    // The companion counts its own terminals; the integrated one this window owns is added separately.
    expect(await monitor.activity()).toEqual({ runningTurns: 1, packageOperations: 0, runningTerminals: 3 })
    expect(await monitor.blockers()).toEqual(['a running turn', 'a running DSH terminal command'])
  })

  it('refuses a restart whose work it could not query', async () => {
    native.terminals.length = 0
    const monitor = new RestartActivityMonitor(
      () => undefined,
      () => native.terminals,
      async () => { throw new Error('the companion did not answer the activity query') },
    )
    onTestFinished(() => { monitor.dispose() })

    const blockers = await monitor.blockers()
    expect(blockers.join(' ')).toContain('cannot query')
    expect(blockers.join(' ')).toContain('did not answer')
  })

  it('reports unknown work when no companion and no context can answer', async () => {
    native.terminals.length = 0
    const monitor = new RestartActivityMonitor(() => undefined, () => native.terminals)
    expect(await monitor.blockers()).toEqual(['a turn or package operation this window cannot query'])
    monitor.dispose()
  })
})
