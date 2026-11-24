/**
 * Write one launch setting where it takes effect.
 *
 * `dsh.*` launch settings can be overridden at the workspace and workspace-folder scope. Writing the global value
 * while an override exists succeeds, but the application keeps reading the override, so a command that reported
 * success would leave the runtime on the old value. These helpers pick the layer that owns the effective value and
 * re-read it afterwards.
 * @module @deepseek-ai/dsh-vscode/host/configuration
 */
import * as vscode from 'vscode'

/** The scope one launch setting was written to. */
export interface EffectiveSettingWrite {
  /** Scope the value was written to. */
  readonly target: vscode.ConfigurationTarget
  /** Lower-priority layers a higher-priority write replaced, such as `workspace`. */
  readonly overridden: readonly string[]
}

/**
 * Write one `dsh` setting into the layer that currently decides its value.
 *
 * The global layer is used when no override exists. A workspace override is replaced in place, because a global
 * write would not take effect there. A workspace-folder override cannot be changed from this command, so it is
 * refused with the folder named instead of reporting a save the runtime would ignore.
 * @param key - setting name below the `dsh` section.
 * @param value - the value to store.
 * @returns the scope written and the layers it replaced.
 * @throws when a folder override must be edited by hand, or the written value is not what the setting reads back.
 */
export async function writeEffectiveSetting(key: string, value: string): Promise<EffectiveSettingWrite> {
  const configuration = vscode.workspace.getConfiguration('dsh')
  const { target, overridden } = effectiveSettingWrite(key, configuration)
  await configuration.update(key, value, target)
  const stored: unknown = vscode.workspace.getConfiguration('dsh').get(key)
  if (stored !== value) {
    throw new Error(
      `dsh.${key} still reads ${JSON.stringify(stored)} after writing ${JSON.stringify(value)}; `
      + 'another settings layer overrides it',
    )
  }
  return { target, overridden }
}

/**
 * @param key - setting name below the `dsh` section.
 * @param configuration - configuration whose effective setting will be written.
 * @returns the writable target and the overrides it replaces.
 * @throws when the setting is owned by a workspace folder.
 */
export function effectiveSettingWrite(
  key: string,
  configuration = vscode.workspace.getConfiguration('dsh'),
): EffectiveSettingWrite {
  const inspected = configuration.inspect<unknown>(key)
  if (inspected?.workspaceFolderValue !== undefined) {
    throw new Error(
      `dsh.${key} is set in a workspace folder's settings, which this command cannot change; `
      + 'edit that folder setting and run the command again',
    )
  }
  const overridden: string[] = []
  let target = vscode.ConfigurationTarget.Global
  if (inspected?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace
    overridden.push('workspace')
  }
  return { target, overridden }
}
