/**
 * One rendering for values thrown inside the update modules.
 *
 * A fetch, filesystem, or VS Code call can reject with any value, while a diagnostic line needs one message.
 * @module @deepseek-ai/dsh-vscode/host/update/errors
 */

/**
 * Render a thrown value as a single diagnostic line.
 * @param error - value thrown by a fetch, filesystem, or VS Code call.
 * @returns the Error message, or the string form of a non-Error throw.
 */
export function describeUpdateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
