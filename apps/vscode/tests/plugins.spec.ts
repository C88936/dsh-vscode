/**
 * Local plugin rows: prepared module sources resolve to their package entry,
 * archives are refused in favor of bundle installation, and the generated
 * overlay remains a valid insert list.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginEntry, pluginsPatch } from '../src/host/plugins.ts'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-plugin-test-'))
  roots.push(root)
  return root
}

function fixture(name: string): string {
  const plugin = join(workspace(), name)
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'fixture',
    type: 'module',
    main: 'index.js',
  }))
  writeFileSync(join(plugin, 'index.js'), 'export function apply() {}\n')
  return plugin
}

function packageFixture(name: string, manifest: Record<string, unknown>, files: readonly string[]): string {
  const plugin = join(workspace(), name)
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', ...manifest }))
  for (const file of files) {
    const path = join(plugin, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'export function apply() {}\n')
  }
  return plugin
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pluginsPatch', () => {
  it('inserts one row per local plugin and resolves package directories to entries', () => {
    const tools = fixture('acme-tools')
    const skill = fixture('acme-skill')
    const patch = pluginsPatch([
      { id: 'acme-tools', path: tools },
      { id: 'acme-skill', path: join(skill, 'index.js') },
    ])
    expect(patch).toContain('- insert:')
    expect(patch).toContain('- id: acme-tools')
    expect(patch).toContain(`name: '${pathToFileURL(join(tools, 'index.js')).href}'`)
    expect(patch).toContain('- id: acme-skill')
    expect(patch).toContain(`name: '${pathToFileURL(join(skill, 'index.js')).href}'`)
  })

  it('returns no overlay when nothing is configured', () => {
    expect(pluginsPatch([])).toBeUndefined()
  })

  it('rejects unusable or duplicate ids and empty paths', () => {
    const plugin = fixture('acme')
    expect(() => pluginsPatch([{ id: 'Acme Tools', path: plugin }])).toThrow(/lowercase identifier/u)
    expect(() => pluginsPatch([
      { id: 'acme', path: plugin },
      { id: 'acme', path: plugin },
    ])).toThrow(/duplicate/u)
    expect(() => pluginsPatch([{ id: 'acme', path: '  ' }])).toThrow(/no path/u)
  })

  it('resolves exports and escapes quotes in the YAML scalar', () => {
    const plugin = fixture("it's-here")
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: 'fixture',
      type: 'module',
      exports: { '.': { import: './dist/main.js', default: './dist/main.js' } },
    }))
    mkdirSync(join(plugin, 'dist'))
    writeFileSync(join(plugin, 'dist', 'main.js'), 'export function apply() {}\n')
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'main.js')).href)
    expect(pluginsPatch([{ id: 'acme', path: plugin }])).toContain("it''s-here")
  })

  it('rejects relative and missing paths', () => {
    expect(() => pluginEntry('plugins/acme')).toThrow(/absolute/u)
    expect(() => pluginEntry(join(tmpdir(), 'definitely-missing-dsh-plugin'))).toThrow(/does not exist/u)
  })
})

describe('pluginEntry archives', () => {
  it('refuses archive inputs and directs the user to bundle installation', () => {
    const root = workspace()
    for (const name of ['acme.tgz', 'acme.tar.gz', 'acme.tar', 'acme.zip']) {
      const archive = join(root, name)
      writeFileSync(archive, '')
      expect(() => pluginEntry(archive)).toThrow(/archive, not a module/u)
      expect(() => pluginEntry(archive)).toThrow(/Install the package as a bundle from the Plugins page/u)
    }
  })

  it('still resolves prepared module files and package directories', () => {
    const plugin = fixture('acme')
    expect(pluginEntry(join(plugin, 'index.js'))).toBe(pathToFileURL(join(plugin, 'index.js')).href)
    expect(pluginEntry(pathToFileURL(plugin).href)).toBe(pathToFileURL(join(plugin, 'index.js')).href)
  })
})

describe('pluginEntry exports resolution', () => {
  it('resolves a string root export', () => {
    const plugin = packageFixture('string-root', { exports: './dist/plugin.js' }, ['dist/plugin.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('resolves a dot-root map export', () => {
    const plugin = packageFixture('dot-root', { exports: { '.': './dist/plugin.js' } }, ['dist/plugin.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('resolves a root condition map without main', () => {
    const plugin = packageFixture('condition-root', {
      exports: { import: './dist/plugin.js', default: './dist/default.js' },
    }, ['dist/plugin.js', 'dist/default.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('uses the first successful entry of an array', () => {
    const plugin = packageFixture('array-root', {
      exports: { '.': [{ require: './dist/plugin.cjs' }, { node: './dist/plugin.js' }] },
    }, ['dist/plugin.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('continues past invalid array targets to a later valid target', () => {
    const plugin = packageFixture('array-invalid', {
      exports: { '.': [42, { browser: './dist/browser.js' }, './dist/plugin.js'] },
    }, ['dist/plugin.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('continues past an explicit null array target, as Node does', () => {
    const plugin = packageFixture('array-null', {
      exports: { '.': [null, './dist/plugin.js'] },
    }, ['dist/plugin.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'plugin.js')).href)
  })

  it('keeps an existing array target whose file is missing an error', () => {
    const plugin = packageFixture('array-missing', {
      exports: { '.': ['./dist/missing.js', './dist/plugin.js'] },
    }, ['dist/plugin.js'])
    expect(() => pluginEntry(plugin)).toThrow(/entry does not exist or is not a file/u)
  })

  it('resolves nested condition maps in declaration order', () => {
    const plugin = packageFixture('nested-root', {
      exports: { '.': { import: { node: './dist/node.js', default: './dist/default.js' } } },
    }, ['dist/node.js', 'dist/default.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'node.js')).href)
  })

  it('falls back to an outer default when a nested active condition misses', () => {
    const plugin = packageFixture('nested-miss', {
      main: 'index.js',
      exports: {
        import: { browser: './browser.js' },
        default: './default.js',
      },
    }, ['index.js', 'browser.js', 'default.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'default.js')).href)
  })

  it('refuses when every active condition misses instead of using index.js', () => {
    const plugin = packageFixture('nested-exhausted', {
      main: 'index.js',
      exports: { '.': { import: { browser: './dist/browser.js', worker: './dist/worker.js' } } },
    }, ['index.js', 'dist/browser.js', 'dist/worker.js'])
    expect(() => pluginEntry(plugin)).toThrow(/no root module for the import condition/u)
  })

  it('resolves active conditions in declaration order', () => {
    const plugin = packageFixture('condition-order', {
      exports: { '.': { default: './dist/default.js', import: './dist/import.js' } },
    }, ['dist/default.js', 'dist/import.js'])
    expect(pluginEntry(plugin)).toBe(pathToFileURL(join(plugin, 'dist', 'default.js')).href)
  })

  it('rejects a missing export target instead of falling back to index.js', () => {
    const plugin = packageFixture('missing-target', {
      main: 'index.js',
      exports: { '.': './dist/missing.js' },
    }, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/entry does not exist or is not a file/u)
  })

  it('refuses an explicit null root target instead of falling back to index.js', () => {
    const plugin = packageFixture('null-root', {
      main: 'index.js',
      exports: { '.': null },
    }, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/refuses the import condition/u)
  })

  it('does not continue past an active condition whose target is null', () => {
    const plugin = packageFixture('null-condition', {
      main: 'index.js',
      exports: { '.': { import: null, default: './dist/default.js' } },
    }, ['index.js', 'dist/default.js'])
    expect(() => pluginEntry(plugin)).toThrow(/refuses the import condition/u)
  })

  it('refuses a null exports field instead of using module or main', () => {
    const plugin = packageFixture('null-exports', { main: 'index.js', exports: null }, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/refuses the import condition/u)
  })

  it('rejects an explicit export without an import condition', () => {
    const plugin = packageFixture('require-only', {
      main: 'index.js',
      exports: { '.': { require: './dist/plugin.cjs' } },
    }, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/no root module for the import condition/u)
  })

  it('rejects an invalid export target value', () => {
    const plugin = packageFixture('invalid-target', {
      main: 'index.js',
      exports: { '.': 42 },
    }, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/invalid exports target/u)
  })

  it('rejects an export target that is not a relative path', () => {
    const plugin = packageFixture('bare-target', {
      main: 'index.js',
      exports: { '.': 'plugin' },
    }, ['index.js', 'plugin'])
    expect(() => pluginEntry(plugin)).toThrow(/invalid exports target/u)
  })

  it('rejects a package that declares no module entry', () => {
    const plugin = packageFixture('no-entry', {}, ['index.js'])
    expect(() => pluginEntry(plugin)).toThrow(/declares no module entry/u)
  })
})
