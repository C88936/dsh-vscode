/**
 * Materialized webview bundle cache.
 *
 * Each host generation materializes the client bundles its boot graph names by
 * URL hash. A later release composes different rows, so files from a removed
 * row would stay in the cache forever; the boot that names the current graph
 * also removes everything it did not materialize.
 * @module @deepseek-ai/dsh-vscode/host/webview-cache
 */
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Remove files in one materialized directory that the current launch did not write.
 *
 * Package assets are named by their reference, so a launch that prepares a
 * different asset set leaves files no page asks for.
 * @param directory - materialized directory; a missing directory is unchanged.
 * @param keep - file names this launch wrote.
 * @returns the number of removed files.
 */
export function removeStaleFiles(directory: string, keep: ReadonlySet<string>): number {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // The launch prepared no file in this directory yet.
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (keep.has(entry)) continue
    rmSync(join(directory, entry), { force: true })
    removed++
  }
  return removed
}

/**
 * Remove cached bundle files the current boot graph did not materialize.
 * @param directory - materialized bundle directory; a missing directory is unchanged.
 * @param keep - file names the current graph materialized.
 * @returns the number of removed bundle files (source maps count with their bundle).
 */
export function removeStaleBundles(directory: string, keep: ReadonlySet<string>): number {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // A first boot has materialized nothing yet.
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.js') || keep.has(entry)) continue
    rmSync(join(directory, entry), { force: true })
    rmSync(join(directory, `${entry}.map`), { force: true })
    removed++
  }
  return removed
}
