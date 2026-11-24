/**
 * Qualified Windows x64 payload selection: debug symbols and foreign prebuild
 * trees leave the runtime, the win32-x64 helpers and licenses stay, and a
 * runtime that lost a required file or regained a foreign payload fails.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { measureRuntime, pruneRuntime, validateRuntime } from '../scripts/runtime-layout.mjs'

const roots: string[] = []

/**
 * @param root - runtime root. @param path - file path below it. @param bytes - content size.
 */
function file(root: string, path: string, bytes = 8): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, 'x'.repeat(bytes))
}

/**
 * Build a minimal runtime that satisfies every required entry.
 * @returns its absolute root.
 */
function runtime(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-layout-'))
  roots.push(root)
  file(root, 'package.json')
  file(root, 'node.exe')
  for (const name of ['dsh-app-boot', 'dsh-base', 'dsh-web-app', 'dsh-official-bundles', 'dsh-skill-office']) {
    file(root, `node_modules/@deepseek-ai/${name}/package.json`)
  }
  file(root, 'node_modules/@deepseek-ai/dsh-skill-office/assets/office/SKILL.md')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit/package.json')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit/LICENSE')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit/NOTICE')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/package.json')
  file(root, 'node_modules/node-pty/package.json')
  file(root, 'node_modules/node-pty/LICENSE')
  file(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 4096)
  file(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll', 2048)
  file(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 2048)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pruneRuntime', () => {
  it('omits debug symbols and foreign node-pty prebuilds but keeps the win32-x64 helpers', () => {
    const root = runtime()
    file(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.pdb', 1000)
    file(root, 'node_modules/node-pty/prebuilds/win32-arm64/conpty.node', 500)
    file(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 500)
    file(root, 'node_modules/node-pty/prebuilds/linux-x64/pty.node', 500)

    const report = pruneRuntime(root)

    expect(report.removedFiles).toBe(4)
    expect(report.removedBytes).toBe(2500)
    expect(report.byRule['debug-symbols']?.files).toBe(1)
    expect(report.byRule['node-pty-foreign-prebuilds']?.files).toBe(3)
    expect(statSync(join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll')).size).toBe(2048)
    expect(statSync(join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node')).size).toBe(4096)
    expect(() => statSync(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64'))).toThrow()
    expect(() => statSync(join(root, 'node_modules/node-pty/prebuilds/win32-arm64'))).toThrow()
  })

  it('keeps licenses, notices, and non-matching package payloads', () => {
    const root = runtime()
    file(root, 'node_modules/some-package/lib/readme.txt', 12)
    pruneRuntime(root)
    expect(statSync(join(root, 'node_modules/@deepseek-ai/libreoffice-kit/NOTICE')).size).toBe(8)
    expect(statSync(join(root, 'node_modules/some-package/lib/readme.txt')).size).toBe(12)
  })

  it('does not match a package by a name prefix', () => {
    const root = runtime()
    file(root, 'node_modules/node-pty-helper/prebuilds/darwin-x64/pty.node', 64)
    const report = pruneRuntime(root)
    expect(report.removedFiles).toBe(0)
  })
})

describe('staged package tooling', () => {
  it('keeps the pnpm payload that preparation stages', () => {
    const root = runtime()
    file(root, 'node_modules/pnpm/package.json')
    file(root, 'node_modules/pnpm/bin/pnpm.mjs')
    file(root, 'node_modules/pnpm/dist/pnpm.mjs')
    // pnpm bundles its own accelerators for every platform inside the package;
    // only the win32-x64 one is reachable, and they are not package roots.
    file(root, 'node_modules/pnpm/dist/node_modules/@reflink/reflink-darwin-arm64/reflink.darwin-arm64.node')
    file(root, 'node_modules/pnpm/dist/node_modules/@reflink/reflink-win32-arm64-msvc/reflink.win32-arm64-msvc.node')
    pruneRuntime(root)
    expect(() => validateRuntime(root)).not.toThrow()
    expect(statSync(join(root, 'node_modules/pnpm/bin/pnpm.mjs')).size).toBe(8)
  })
})

describe('validateRuntime', () => {
  it('accepts the selected win32-x64 payload', () => {
    const root = runtime()
    expect(() => validateRuntime(root)).not.toThrow()
  })

  it('names a missing required file', () => {
    const root = runtime()
    rmSync(join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe'))
    expect(() => validateRuntime(root)).toThrow(/OpenConsole\.exe/u)
  })

  it('rejects a runtime that still carries a foreign native payload', () => {
    const root = runtime()
    file(root, 'node_modules/sharp-darwin-arm64/lib/sharp.node', 32)
    expect(() => validateRuntime(root)).toThrow(/foreign native payload remains: sharp-darwin-arm64/u)
  })

  it('rejects an unpruned debug symbol', () => {
    const root = runtime()
    file(root, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/engine.pdb', 32)
    expect(() => validateRuntime(root)).toThrow(/debug symbol remains/u)
  })

  it('rejects a missing license or attribution file', () => {
    const root = runtime()
    rmSync(join(root, 'node_modules/node-pty/LICENSE'))
    expect(() => validateRuntime(root)).toThrow(/license or attribution file/u)
  })
})

describe('measureRuntime', () => {
  it('reports the selected file count and uncompressed bytes', () => {
    const root = runtime()
    const measured = measureRuntime(root)
    expect(measured.files).toBeGreaterThan(10)
    expect(measured.bytes).toBeGreaterThan(0)
  })
})
