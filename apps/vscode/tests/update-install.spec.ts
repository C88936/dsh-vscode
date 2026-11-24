/**
 * Applying a verified VSIX: the install command runs before the reload, running work is confirmed with the user
 * instead of interrupted, and every failure leaves the current install usable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  /** Every command the module executed through the VS Code default. */
  commands: [] as { command: string; args: unknown[] }[],
}))

vi.mock('vscode', () => ({
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      native.commands.push({ command, args })
      return undefined
    },
  },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}))

import { installStagedUpdate, type InstallStagedUpdateOptions } from '../src/host/update/install.ts'

const STAGED = { path: 'C:/storage/updates/dsh-vscode-0.2.0.vsix', version: '0.2.0' }

/**
 * @param commands - executed command names, in order. @returns a command executor that records them.
 */
function executor(commands: string[], result: boolean | undefined = undefined) {
  return async (command: string, ...args: readonly unknown[]) => {
    commands.push(args.length > 0 ? `${command} ${JSON.stringify(args[0])}` : command)
    return result
  }
}

/**
 * @param overrides - fields the case changes.
 * @returns options for one install against doubles.
 */
function options(overrides: Partial<InstallStagedUpdateOptions> = {}): InstallStagedUpdateOptions {
  return {
    ...STAGED,
    guard: { blockers: () => [] },
    confirm: async () => false,
    ...overrides,
  }
}

beforeEach(() => {
  native.commands.length = 0
})

describe('installStagedUpdate', () => {
  it('installs a file URI, then reloads the window', async () => {
    const commands: string[] = []
    const outcome = await installStagedUpdate(options({ executeCommand: executor(commands) }))
    expect(outcome).toEqual({ ok: true, version: '0.2.0' })
    expect(commands).toEqual([
      'workbench.extensions.installExtension {"fsPath":"C:/storage/updates/dsh-vscode-0.2.0.vsix"}',
      'workbench.action.reloadWindow',
    ])
  })

  it('installs through the VS Code defaults with a file URI', async () => {
    const outcome = await installStagedUpdate(options())
    expect(outcome.ok).toBe(true)
    expect(native.commands.map(entry => entry.command)).toEqual([
      'workbench.extensions.installExtension',
      'workbench.action.reloadWindow',
    ])
    expect(native.commands[0]?.args).toEqual([{ fsPath: 'C:/storage/updates/dsh-vscode-0.2.0.vsix' }])
  })

  it('asks before interrupting running work and installs when the user agrees', async () => {
    const commands: string[] = []
    const asked: { version: string; work: readonly string[] }[] = []
    const outcome = await installStagedUpdate(options({
      guard: { blockers: () => ['a running turn'] },
      confirm: async (request) => {
        asked.push(request)
        return true
      },
      executeCommand: executor(commands),
    }))
    expect(outcome.ok).toBe(true)
    expect(asked).toEqual([{ version: '0.2.0', work: ['a running turn'] }])
    expect(commands).toHaveLength(2)
  })

  it('leaves the install unstarted when the user declines', async () => {
    const commands: string[] = []
    const outcome = await installStagedUpdate(options({
      guard: { blockers: async () => ['a running turn', 'a running package operation'] },
      confirm: async () => false,
      executeCommand: executor(commands),
    }))
    expect(outcome).toEqual({
      ok: false,
      code: 'work-running',
      detail: 'DSH 0.2.0 was not installed because a running turn, a running package operation is running',
    })
    expect(commands).toEqual([])
  })

  it('asks when the activity monitor cannot establish the work', async () => {
    const asked: readonly string[][] = []
    const outcome = await installStagedUpdate(options({
      guard: { blockers: async () => { throw new Error('the companion did not answer') } },
      confirm: async (request) => {
        asked.push([...request.work])
        return false
      },
    }))
    expect(outcome).toMatchObject({ ok: false, code: 'work-running' })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[0]).toContain('the companion did not answer')
  })

  it('does not reload when VS Code refuses the installation', async () => {
    const commands: string[] = []
    const outcome = await installStagedUpdate(options({ executeCommand: executor(commands, false) }))
    expect(outcome).toMatchObject({ ok: false, code: 'install-failed' })
    expect(commands).toHaveLength(1)
  })

  it('does not reload when the installation command throws', async () => {
    const commands: string[] = []
    const outcome = await installStagedUpdate(options({
      executeCommand: async (command) => {
        commands.push(command)
        throw new Error('the extension gallery refused the package')
      },
    }))
    expect(outcome).toMatchObject({ ok: false, code: 'install-failed' })
    expect(outcome.ok ? '' : outcome.detail).toContain('the extension gallery refused the package')
    expect(commands).toEqual(['workbench.extensions.installExtension'])
  })

  it('reports a reload that did not happen as an installed version', async () => {
    const outcome = await installStagedUpdate(options({
      executeCommand: async (command) => {
        if (command === 'workbench.action.reloadWindow') throw new Error('no window to reload')
        return undefined
      },
    }))
    expect(outcome).toMatchObject({ ok: false, code: 'reload-failed' })
    expect(outcome.ok ? '' : outcome.detail).toContain('DSH 0.2.0 is installed')
  })

  it('stops the old DSH host between the install and the reload', async () => {
    const steps: string[] = []
    const outcome = await installStagedUpdate(options({
      executeCommand: async (command) => {
        steps.push(command)
        return undefined
      },
      handover: async () => { steps.push('handover') },
    }))
    expect(outcome).toEqual({ ok: true, version: '0.2.0' })
    expect(steps).toEqual([
      'workbench.extensions.installExtension',
      'handover',
      'workbench.action.reloadWindow',
    ])
  })

  it('does not reload when the previous DSH host refuses to stop', async () => {
    const commands: string[] = []
    const outcome = await installStagedUpdate(options({
      executeCommand: executor(commands),
      handover: async () => { throw new Error('the shared host still reports 1 running turn') },
    }))
    expect(outcome).toMatchObject({ ok: false, code: 'handover-failed' })
    expect(outcome.ok ? '' : outcome.detail).toContain('is installed, but the previous DSH host did not stop')
    expect(outcome.ok ? '' : outcome.detail).toContain('still reports 1 running turn')
    expect(commands).toEqual([
      'workbench.extensions.installExtension {"fsPath":"C:/storage/updates/dsh-vscode-0.2.0.vsix"}',
    ])
  })
})
