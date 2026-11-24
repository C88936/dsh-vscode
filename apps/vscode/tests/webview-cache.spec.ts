/**
 * Stale webview bundle cleanup: a new composition removes the files its boot
 * graph did not materialize and keeps everything it did.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeStaleBundles } from '../src/host/webview-cache.ts'

const roots: string[] = []

/**
 * @returns a temporary bundle directory.
 */
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-bundles-'))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * @param root - bundle directory. @param name - file name.
 */
function file(root: string, name: string): void {
  writeFileSync(join(root, name), 'bundle\n')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('removeStaleBundles', () => {
  it('returns zero for a directory that does not exist yet', () => {
    expect(removeStaleBundles(join(tmpdir(), 'dsh-vscode-missing-bundles'), new Set())).toBe(0)
  })

  it('removes an unmaterialized bundle with its source map and keeps the current one', () => {
    const root = directory()
    file(root, 'current.js')
    file(root, 'current.js.map')
    file(root, 'removed.js')
    file(root, 'removed.js.map')
    expect(removeStaleBundles(root, new Set(['current.js']))).toBe(1)
    expect(readdirSync(root).sort()).toEqual(['current.js', 'current.js.map'])
  })

  it('keeps non-bundle files in the directory', () => {
    const root = directory()
    file(root, 'notes.txt')
    expect(removeStaleBundles(root, new Set())).toBe(0)
    expect(readdirSync(root)).toEqual(['notes.txt'])
  })

  it('removes every bundle when nothing was materialized', () => {
    const root = directory()
    file(root, 'one.js')
    file(root, 'two.js')
    expect(removeStaleBundles(root, new Set())).toBe(2)
    expect(readdirSync(root)).toEqual([])
  })
})
