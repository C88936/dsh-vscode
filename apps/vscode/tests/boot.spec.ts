/**
 * Installation-anchor resolution: a configured runtime wins, a checkout anchors
 * on the launcher manifest, and an unusable path fails loudly. The package
 * tooling resolves from the payload at that anchor, never from `PATH`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dropRetiredBundles, findPackageTooling, resolveInstallAnchor, resolveInstalledDshVersion } from '../src/host/boot.ts'

const workspaces: string[] = []

/**
 * Create a temporary directory tree.
 * @returns its absolute path.
 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vscode-anchor-'))
  workspaces.push(dir)
  return dir
}

/**
 * @param dir - directory to create. @param name - file name inside it.
 */
function manifest(dir: string, name = 'package.json'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), '{"name":"fixture"}\n')
}

/**
 * Write one file below a fixture root.
 * @param root - fixture root. @param relative - path below it. @param text - file content.
 */
function file(root: string, relative: string, text: string): void {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

/**
 * Create a staged runtime payload that carries pnpm, like the standalone
 * preparation publishes.
 * @param root - runtime root. @param options - pnpm version, bin declaration, recorded Node file.
 * @returns the installation anchor inside that runtime.
 */
function runtimePayload(
  root: string,
  options: { version?: string; bin?: unknown; nodeFile?: string } = {},
): string {
  const version = options.version ?? '11.28.5'
  file(root, 'package.json', `${JSON.stringify({ name: '@deepseek-ai/dsh-vscode-runtime', version: '0.0.1' })}\n`)
  file(root, 'node_modules/pnpm/package.json', `${JSON.stringify({
    name: 'pnpm', version, bin: options.bin ?? { pnpm: 'bin/pnpm.mjs' },
  })}\n`)
  file(root, 'node_modules/pnpm/bin/pnpm.mjs', '')
  if (options.nodeFile !== undefined) {
    file(root, options.nodeFile, '')
    file(root, 'standalone-runtime.json', `${JSON.stringify({ nodeFile: options.nodeFile })}\n`)
  }
  return join(root, 'package.json')
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveInstallAnchor', () => {
  it('anchors a source checkout on the launcher manifest, not its root', () => {
    const root = workspace()
    manifest(root)
    manifest(join(root, 'apps', 'cli'))
    expect(resolveInstallAnchor(root, root)).toBe(join(root, 'apps', 'cli', 'package.json'))
  })

  it('anchors a packaged runtime on its own manifest', () => {
    const root = workspace()
    manifest(root)
    expect(resolveInstallAnchor(root, root)).toBe(join(root, 'package.json'))
  })

  it('walks up from the extension directory when no runtime is configured', () => {
    const root = workspace()
    manifest(root)
    manifest(join(root, 'apps', 'cli'))
    const extension = join(root, 'apps', 'vscode')
    mkdirSync(extension, { recursive: true })
    expect(resolveInstallAnchor(extension)).toBe(join(root, 'apps', 'cli', 'package.json'))
  })

  it('rejects a configured path that holds no installation', () => {
    const root = workspace()
    mkdirSync(join(root, 'empty'), { recursive: true })
    expect(() => resolveInstallAnchor(root, join(root, 'empty'))).toThrow(/dsh\.runtimePath/u)
  })
})

describe('resolveInstalledDshVersion', () => {
  it('reads a direct DSH launcher manifest', () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2-alpha.2"}\n')
    expect(resolveInstalledDshVersion(join(root, 'package.json'))).toBe('0.2.2-alpha.2')
  })

  it('reads the installed DSH package below a dependency-only deploy root', () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"runtime-closure","version":"0.0.1"}\n')
    const installed = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2-alpha.2"}\n')
    expect(resolveInstalledDshVersion(join(root, 'package.json'))).toBe('0.2.2-alpha.2')
  })

  it('does not treat an unrelated deploy-root version as the DSH version', () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"runtime-closure","version":"9.9.9"}\n')
    expect(resolveInstalledDshVersion(join(root, 'package.json'))).toBeUndefined()
  })

  it('reads the base bundle version from a launcher-free VS Code runtime', () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"@deepseek-ai/dsh-vscode-runtime","version":"0.0.1"}\n')
    const base = join(root, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'package.json'), '{"name":"@deepseek-ai/dsh-base","version":"0.2.2-alpha.2"}\n')
    expect(resolveInstalledDshVersion(join(root, 'package.json'))).toBe('0.2.2-alpha.2')
  })
})

describe('findPackageTooling', () => {
  it('resolves the staged pnpm entry and the runtime Node', () => {
    const root = workspace()
    const anchor = runtimePayload(root, { nodeFile: 'node.exe' })
    const lookup = findPackageTooling(anchor)
    if (!('tooling' in lookup)) throw new Error(`expected tooling, received: ${lookup.problem}`)
    expect(lookup.tooling.version).toBe('11.28.5')
    expect(lookup.tooling.entry).toBe(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    expect(lookup.tooling.node).toBe(join(root, 'node.exe'))
    expect(lookup.tooling.env.PATH).toBe(`${root}${delimiter}${process.env.PATH ?? ''}`)
    expect(lookup.tooling.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('uses the process Node and the workspace-root pnpm of a source checkout', () => {
    const root = workspace()
    manifest(join(root, 'apps', 'cli'))
    file(root, 'node_modules/pnpm/package.json', `${JSON.stringify({
      name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' },
    })}\n`)
    file(root, 'node_modules/pnpm/bin/pnpm.mjs', '')
    const lookup = findPackageTooling(join(root, 'apps', 'cli', 'package.json'))
    if (!('tooling' in lookup)) throw new Error(`expected tooling, received: ${lookup.problem}`)
    expect(lookup.tooling.entry).toBe(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    expect(lookup.tooling.node).toBe(process.execPath)
    expect(lookup.tooling.env.PATH).toBe(`${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`)
  })

  it('names every searched location and the preparation command when the payload is missing', () => {
    const root = workspace()
    file(root, 'package.json', '{"name":"@deepseek-ai/dsh-vscode-runtime"}\n')
    const lookup = findPackageTooling(join(root, 'package.json'))
    if ('tooling' in lookup) throw new Error('expected a missing payload')
    expect(lookup.problem).toContain(join(root, 'node_modules', 'pnpm'))
    expect(lookup.problem).toContain('runtime:standalone')
    expect(lookup.problem).toContain('PATH')
  })

  it('rejects a payload that declares no pnpm entry', () => {
    const root = workspace()
    const lookup = findPackageTooling(runtimePayload(root, { bin: {} }))
    if ('tooling' in lookup) throw new Error('expected a missing CLI entry')
    expect(lookup.problem).toContain('no pnpm CLI entry')
  })

  it('rejects a declared entry the payload does not contain', () => {
    const root = workspace()
    const anchor = runtimePayload(root)
    rmSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    const lookup = findPackageTooling(anchor)
    if ('tooling' in lookup) throw new Error('expected a missing CLI entry')
    expect(lookup.problem).toContain(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
  })

  it('reports an unresolved anchor instead of searching the working directory', () => {
    expect(findPackageTooling('')).toEqual({ problem: 'the installation anchor is unresolved' })
  })
})

describe('dropRetiredBundles', () => {
  it('drops the voice bundle from a stored selection', () => {
    const root = workspace()
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-voice-input-bundle'] } },
    }))
    const logs: string[] = []
    const removed = dropRetiredBundles(profile, line => { logs.push(line) })
    expect(removed).toEqual(['@deepseek-ai/dsh-experimental-voice-input-bundle'])
    expect(logs).toEqual(['dsh: removed retired profile bundle @deepseek-ai/dsh-experimental-voice-input-bundle'])
    const stored = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    expect(stored.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('keeps a stored user bundle whose package is temporarily missing', () => {
    const root = workspace()
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['private-bundle-that-is-being-reinstalled'] } },
    }))
    const before = readFileSync(join(profile, 'package.json'), 'utf8')
    expect(dropRetiredBundles(profile, () => {})).toEqual([])
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(before)
  })

  it('leaves a profile with no retired selection untouched', () => {
    const root = workspace()
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    const before = readFileSync(join(profile, 'package.json'), 'utf8')
    expect(dropRetiredBundles(profile, () => {})).toEqual([])
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(before)
  })
})
