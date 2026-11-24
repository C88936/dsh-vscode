/**
 * Real composition: boot a test-only `cordis.yml` through the Loader with the
 * shipped bundle patch, then assert the model-visible `read`, `grep`, and
 * `glob` results a session sees.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as NativeToolFs from '@deepseek-ai/dsh-tool-fs'
import * as EncodedSource from '@deepseek-ai/dsh-tool-fs-encoded-source'
import * as NativeSearch from '@deepseek-ai/dsh-tool-fs-search'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeLegacy, encodeUtf8 } from './support/codec.ts'

/** The shipped bundle directory. */
const BUNDLE_DIR = fileURLToPath(new URL('../../../../apps/vscode/deploy/encoded-source/', import.meta.url))

/** The shipped Web bundle, whose presets the bundle layer rewrites. */
const WEB_APP_DIR = fileURLToPath(new URL('../../../../packages/bundle/web-app/', import.meta.url))

/** Chinese fixture text every assertion reads. */
const TEXT = '第一行 中文标题\n第二行 普通内容\n'

let context: Context | undefined
let workspace: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

/**
 * Write the test-only composition: the same services a profile mounts, plus the
 * native tool rows the shipped base patch addresses when `toolRows` is on.
 * @param root - directory the config and workspace live in.
 * @param toolRows - whether to mount the native `tool-fs` and `tool-fs-search` rows.
 * @returns the config file path.
 */
async function writeComposition(root: string, toolRows = true): Promise<{ configPath: string; cwd: string }> {
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'legacy'), { recursive: true })
  await writeFile(join(cwd, 'legacy', 'Main.cls'), encodeLegacy(TEXT))
  await writeFile(join(cwd, 'src.cs'), encodeUtf8(TEXT))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-tool-executor-native' },
    { name: '@deepseek-ai/dsh-fs-local', config: { cwd } },
    { name: '@deepseek-ai/dsh-subprocess-local' },
    { name: '@deepseek-ai/dsh-fs-observation-policy' },
    { name: 'fixture:working-directory' },
    ...toolRows ? [
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: true } },
    ] : [],
  ], null, 2))
  return { configPath, cwd }
}

/**
 * Boot the composition through the Loader.
 * @param root - directory holding the config and workspace.
 * @param options - whether native tool rows are mounted, and whether to apply
 *   both shipped layers or only the file the bundle declares.
 * @returns the live context and the workspace directory.
 */
async function bootComposition(
  root: string,
  options: { toolRows?: boolean; bundlePatchesOnly?: boolean } = {},
): Promise<{ ctx: Context; cwd: string }> {
  const { configPath, cwd } = await writeComposition(root, options.toolRows ?? true)
  const booted = new Context()
  booted.baseUrl = `${pathToFileURL(root).href}/`
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-fs-observation-policy', FsObservationPolicy],
    ['@deepseek-ai/dsh-tool-fs', NativeToolFs],
    ['@deepseek-ai/dsh-tool-fs-search', NativeSearch],
    ['@deepseek-ai/dsh-tool-fs-encoded-source', EncodedSource],
    ['fixture:working-directory', (ctx: Context): void => { provideWorkingDirectoryFixture(ctx, cwd) }],
  ])
  type Internal = NonNullable<typeof booted.loader.internal>
  const internal: Pick<Internal, 'version' | 'import'> = {
    version: 'v2',
    import: async (specifier: string) => {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  }
  booted.loader.internal = internal as Internal
  const bundlePatches = loadOverlayPatches('dsh', join(BUNDLE_DIR, 'presets.patch.yml')) ?? []
  const patches = options.bundlePatchesOnly === true
    ? bundlePatches
    : [
      // The bundle applies only the Agent-preset layer. The top-level sample is
      // applied here to exercise the base/headless composition it is written for.
      ...loadOverlayPatches('dsh', join(BUNDLE_DIR, 'cordis.base.patch.yml')) ?? [],
      ...bundlePatches,
    ]
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await booted.loader.await()
  context = booted
  return { ctx: booted, cwd }
}

/**
 * Invoke one model-visible tool through the shared pipeline.
 * @param ctx - the live composition.
 * @param cwd - the session working directory.
 * @param name - the tool name.
 * @param args - the raw tool arguments.
 * @returns the settled result.
 */
async function callTool(ctx: Context, cwd: string, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`composition-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    agent: { session: { header: { id: 'composition-session', cwd } } } as never,
  })
}

/**
 * Join the text blocks of one tool result.
 * @param result - the settled result.
 * @returns the model-facing text.
 */
function resultText(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('encoded source through a real Loader composition', () => {
  it('serves the replacement read and grep, keeps glob, and disables the installed search row', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dsh-encoded-compose-'))
    const { ctx, cwd } = await bootComposition(workspace)

    // The bundle patch replaced the two native rows in this composition.
    const read = ctx.tools.get('read')
    expect(read?.description).toBe('Read a text file and return line-numbered content.')
    expect(ctx.tools.get('grep')).toBeDefined()
    expect(ctx.tools.get('glob')).toBeDefined()

    const legacy = await callTool(ctx, cwd, 'read', { file_path: 'legacy/Main.cls' })
    expect(legacy.isError).toBe(false)
    expect(resultText(legacy)).toContain('1: 第一行 中文标题')
    expect(resultText(legacy)).toContain('2: 第二行 普通内容')

    const utf8 = await callTool(ctx, cwd, 'read', { file_path: 'src.cs', offset: 2, limit: 1 })
    expect(resultText(utf8)).toContain('2: 第二行 普通内容')
    expect(resultText(utf8)).toContain('(End of file - total 2 lines)')

    const grepped = await callTool(ctx, cwd, 'grep', { pattern: '普通内容', path: '.' })
    expect(grepped.isError).toBe(false)
    expect(resultText(grepped)).toContain('Found 2 matches')
    expect(resultText(grepped)).toContain('Line 2: 第二行 普通内容')

    const globbed = await callTool(ctx, cwd, 'glob', { pattern: '**/*.cls' })
    expect(resultText(globbed)).toContain('Main.cls')
  })

  it('leaves a composition without native tool rows untouched, so a Minimal preset gains nothing', async () => {
    // The bundle applies only the Agent-preset layer. A profile layer that
    // inserts the replacement tools at the top level would register `read`,
    // `grep`, and `glob` for every Agent, including presets that never had them.
    workspace = await mkdtemp(join(tmpdir(), 'dsh-encoded-isolation-'))
    const { ctx, cwd } = await bootComposition(workspace, { toolRows: false, bundlePatchesOnly: true })
    expect(ctx.tools.get('read')).toBeUndefined()
    expect(ctx.tools.get('grep')).toBeUndefined()
    expect(ctx.tools.get('glob')).toBeUndefined()
    expect(cwd).toBe(join(workspace, 'workspace'))
  })
})

describe('shipped bundle files', () => {
  it('composes the preset layer into both shipped presets', async () => {
    const presetLayer = loadOverlayPatches('dsh', join(BUNDLE_DIR, 'presets.patch.yml')) ?? []
    // Both layers must mount the same plugin config: the preset layer is
    // regenerated from the shipped presets, so a change to the top-level row
    // would otherwise drift silently.
    const topLayer = loadOverlayPatches('dsh', join(BUNDLE_DIR, 'cordis.base.patch.yml')) ?? []
    const topEntry = topLayer
      .flatMap(patch => patch.insert ?? [])
      .find(entry => entry.id === 'tool-fs-encoded-source')
    const topConfig = topEntry?.config as Record<string, unknown> | undefined
    expect(topConfig).toBeDefined()
    for (const preset of ['standard', 'ptc']) {
      const shipped = loadOverlayPatches('dsh', join(WEB_APP_DIR, 'presets', `${preset}.patch.yml`)) ?? []
      const composed = composeEntries([shipped, presetLayer])
      const row = composed.find(entry => entry.id === `preset-${preset}`)
      const plugins = (row?.config as { plugins: { id: string; disabled?: boolean; config?: Record<string, unknown> }[] }).plugins
      const shippedPlugins = (shipped[0]?.insert?.[0]?.config as { plugins: { id: string }[] }).plugins
      const expectedIds: string[] = []
      for (const plugin of shippedPlugins) {
        expectedIds.push(plugin.id)
        if (plugin.id === 'tool-fs-search') expectedIds.push('tool-fs-encoded-source')
      }
      expect(plugins.map(plugin => plugin.id)).toEqual(expectedIds)
      expect(plugins.find(plugin => plugin.id === 'tool-fs')?.config).toEqual({ read: false })
      expect(plugins.find(plugin => plugin.id === 'tool-fs-search')?.disabled).toBe(true)
      expect(plugins.find(plugin => plugin.id === 'tool-fs-encoded-source')?.config).toEqual(topConfig)
    }
  })

  it('leaves the Minimal preset unchanged', async () => {
    const presetLayer = loadOverlayPatches('dsh', join(BUNDLE_DIR, 'presets.patch.yml')) ?? []
    const shipped = loadOverlayPatches('dsh', join(WEB_APP_DIR, 'presets', 'minimal.patch.yml')) ?? []
    const composed = composeEntries([shipped, presetLayer])
    const row = composed.find(entry => entry.id === 'preset-minimal')
    const shippedConfig = shipped[0]?.insert?.[0]?.config
    expect(row?.config).toEqual(shippedConfig)
    expect(JSON.stringify(row?.config)).not.toContain('tool-fs-encoded-source')
  })

  it('records the bundle manifest and the verified offline closure the plugin manager reads', async () => {
    const pluginName = '@deepseek-ai/dsh-tool-fs-encoded-source'
    const pluginVersion = '0.2.2-alpha.2'
    const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8')) as {
      name: string
      version: string
      dsh: { bundle: { patch: string[] } }
      dependencies: Record<string, string>
    }
    expect(manifest.dsh.bundle.patch).toEqual(['./presets.patch.yml'])
    expect(manifest.dependencies[pluginName]).toBe(pluginVersion)
    const record = JSON.parse(await readFile(join(BUNDLE_DIR, 'dsh-prepared-bundle.json'), 'utf8')) as {
      format: string
      name: string
      version: string
      lockfile: { path: string; sha256: string }
      hostProvided: string[]
      packages: { name: string; version: string; path: string; integrity: string }[]
      tarballs: { name: string; version: string; file: string; integrity: string }[]
    }
    expect(record).toMatchObject({
      format: 'dsh-prepared-bundle/v1',
      name: manifest.name,
      version: manifest.version,
      hostProvided: [],
    })
    // The plugin is part of the closure, not something the installation supplies.
    expect(record.packages).toHaveLength(1)
    const recorded = record.packages[0]
    expect(recorded).toMatchObject({ name: pluginName, version: pluginVersion })
    expect(recorded?.path).toBe(`node_modules/${pluginName}`)
    const tarball = record.tarballs.find(item => item.name === pluginName)
    expect(tarball).toBeDefined()
    const tarballBytes = await readFile(join(BUNDLE_DIR, tarball?.file ?? ''))
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`
    expect(tarball?.integrity).toBe(integrity)
    expect(recorded?.integrity).toBe(integrity)
    // The installed copy the record names must be the package this closure tarball carries.
    const installed = JSON.parse(await readFile(join(BUNDLE_DIR, recorded?.path ?? '', 'package.json'), 'utf8')) as {
      name: string
      version: string
      main: string
    }
    expect(installed).toMatchObject({ name: pluginName, version: pluginVersion, main: 'lib/index.js' })
    const lockfileBytes = await readFile(join(BUNDLE_DIR, record.lockfile.path))
    expect(createHash('sha256').update(lockfileBytes).digest('hex')).toBe(record.lockfile.sha256)
    // The lockfile is the closure the record proves: one importer dependency, resolved to the same integrity.
    expect(lockfileBytes.toString('utf8')).toContain(`'${pluginName}@${pluginVersion}'`)
    expect(lockfileBytes.toString('utf8')).toContain(integrity)
  })
})
