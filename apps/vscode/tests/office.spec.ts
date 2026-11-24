/**
 * Office composition: the bundled skills mount from the installation the
 * profile boots, and the authoring payload joins them only when it targets this
 * platform.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { officeComposition } from '../src/host/office.ts'

const roots: string[] = []

/**
 * @param root - installation root. @param path - file path below it. @param content - file body.
 */
function file(root: string, path: string, content = '{}\n'): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

/**
 * Build an installation with the Office package, its assets, the Kit CLI, and a Node executable.
 * @returns the installation `package.json` path.
 */
function installation(): { anchor: string; node: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-office-'))
  roots.push(root)
  file(root, 'package.json', '{"name":"@deepseek-ai/dsh-vscode-runtime"}\n')
  file(root, 'node.exe')
  file(root, 'node_modules/@deepseek-ai/dsh-skill-office/package.json')
  file(root, 'node_modules/@deepseek-ai/dsh-skill-office/assets/office/SKILL.md', '# office\n')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit/package.json')
  file(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js')
  return { anchor: join(root, 'package.json'), node: join(root, 'node.exe'), root }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('officeComposition', () => {
  it('mounts the bundled skills with the Kit CLI and Node executable', () => {
    const { anchor, node } = installation()
    const composition = officeComposition({ installAnchor: anchor, node })
    if ('reason' in composition) throw new Error(composition.reason)
    const rows = load(composition.patch) as { insert: { id: string; name: string; config?: Record<string, string> }[] }[]
    const insert = rows[0]?.insert ?? []
    const skill = insert.find(row => row.id === 'skill-office')
    expect(skill?.name).toBe('@deepseek-ai/dsh-skill-office')
    expect(skill?.config?.assetRoot).toBe(join(installationRoot(anchor), 'node_modules/@deepseek-ai/dsh-skill-office/assets'))
    expect(skill?.config?.cli).toBe(join(installationRoot(anchor), 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'))
    expect(skill?.config?.node).toBe(node)
    expect(insert.find(row => row.id === 'workspace-dependencies')).toBeUndefined()
    expect(composition.detail).toMatch(/authoring needs a primary runtime payload/u)
  })

  it('mounts the authoring payload when it targets this platform', () => {
    const { anchor, node, root } = installation()
    file(root, 'primary-runtime/runtime.json', JSON.stringify({ platform: process.platform, arch: process.arch }))
    const composition = officeComposition({ installAnchor: anchor, node })
    if ('reason' in composition) throw new Error(composition.reason)
    const rows = load(composition.patch) as { insert: { id: string; config?: Record<string, string> }[] }[]
    expect(rows[0]?.insert.find(row => row.id === 'workspace-dependencies')?.config?.source)
      .toBe(join(root, 'primary-runtime'))
    expect(composition.detail).toMatch(/bundled authoring payload/u)
  })

  it('keeps rendering and export working when the payload targets another platform', () => {
    const { anchor, node, root } = installation()
    file(root, 'primary-runtime/runtime.json', JSON.stringify({ platform: 'darwin', arch: 'arm64' }))
    const composition = officeComposition({ installAnchor: anchor, node })
    if ('reason' in composition) throw new Error(composition.reason)
    const rows = load(composition.patch) as { insert: { id: string }[] }[]
    expect(rows[0]?.insert.some(row => row.id === 'workspace-dependencies')).toBe(false)
    expect(composition.detail).toMatch(/darwin-arm64/u)
  })

  it('reports a missing Office package instead of mounting an unusable row', () => {
    const { anchor, node } = installation()
    rmSync(join(installationRoot(anchor), 'node_modules/@deepseek-ai/dsh-skill-office'), { recursive: true })
    const composition = officeComposition({ installAnchor: anchor, node })
    expect('reason' in composition && composition.reason).toMatch(/dsh-skill-office is not installed/u)
  })

  it('reports a missing Kit CLI', () => {
    const { anchor, node } = installation()
    rmSync(join(installationRoot(anchor), 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'))
    const composition = officeComposition({ installAnchor: anchor, node })
    expect('reason' in composition && composition.reason).toMatch(/LibreOffice Kit CLI is missing/u)
  })

  it('rejects a Node value that is not a file', () => {
    const { anchor } = installation()
    const composition = officeComposition({ installAnchor: anchor, node: 'node' })
    expect('reason' in composition && composition.reason).toMatch(/absolute Node executable/u)
  })
})

/**
 * @param anchor - installation manifest. @returns its directory.
 */
function installationRoot(anchor: string): string {
  return join(anchor, '..')
}
