/**
 * Boot the DSH application inside the VS Code extension host.
 *
 * This mirrors the in-process composition of `apps/desktop-host` and the
 * worker preview host: the loaded Web profile supplies the application rows,
 * an extension-owned overlay disables the HTTP listener rows, and the
 * extension drives `ctx.connection` directly instead of a socket.
 * @module @deepseek-ai/dsh-vscode/host/boot
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { WorkspaceRegistration } from './workspace-registration.ts'
import { registerManagedExtensions, type ExtensionSkillRegistry } from './managed-extensions.ts'

/** Profile name; also the name recorded in `profileContext`. */
const NAME = 'dsh'

/** The application the extension owns for its whole activation. */
export interface DshApplication {
  /** Root Cordis context of the live DSH tree. */
  readonly ctx: Context
  /** Absolute directory of the application-owned profile. */
  readonly profileDir: string
  /** Absolute path of the installation anchor used for resolution. */
  readonly installAnchor: string
  /** Load one package from that installation. */
  readonly load: <T>(specifier: string) => Promise<T>
}

/** Inputs for one in-process boot. */
export interface BootDshOptions {
  /** Absolute path of this extension directory, used to locate a packaged runtime. */
  readonly extensionPath: string
  /** Extension-owned storage directory; the profile lives below it. */
  readonly storageDir: string
  /** Shipped overlay patch that turns the Web composition into a page-less surface. */
  readonly overlayPath: string
  /** Additional overlays applied above the shipped one, in order. */
  readonly extraOverlays?: readonly string[]
  /** Working directory for the application; the VS Code workspace folder when there is one. */
  readonly cwd?: string
  /** VS Code workspace folder that DSH should register before the UI opens. */
  readonly workspacePath?: string
  /** Configured DSH installation: a package directory or a source checkout. */
  readonly runtimePath?: string
  /** Diagnostic sink for boot progress and per-plugin failures. */
  readonly log: (line: string) => void
}

/**
 * Resolve the installation anchor: the package.json whose dependency graph
 * supplies every DSH package the profile's bundles name.
 * @param extensionPath - absolute path of this extension directory.
 * @param runtimePath - configured DSH installation, when one is set.
 * @returns absolute path of an existing installation `package.json`.
 * @throws when neither the packaged runtime nor the source workspace is found.
 */
export function resolveInstallAnchor(extensionPath: string, runtimePath?: string): string {
  if (runtimePath !== undefined && runtimePath !== '') {
    // A source checkout anchors on the launcher manifest, which declares every
    // bundle the profile names; a packaged installation anchors on its own root.
    const checkout = join(runtimePath, 'apps', 'cli', 'package.json')
    if (existsSync(checkout)) return checkout
    const direct = join(runtimePath, 'package.json')
    if (existsSync(direct)) return direct
    throw new Error(`dsh: no DSH installation at the configured dsh.runtimePath: ${runtimePath}`)
  }
  const packaged = join(extensionPath, 'runtime', 'package.json')
  if (existsSync(packaged)) return packaged
  return walkForCheckout(extensionPath)
}

/**
 * Read the installed DSH release version from the launcher manifest, or from
 * the base bundle when the composition ships no launcher.
 * @param installAnchor - resolved installation manifest.
 * @returns the release version, or undefined when the manifest is unreadable.
 */
export function resolveInstalledDshVersion(installAnchor: string): string | undefined {
  const candidates = [
    { path: installAnchor, name: '@deepseek-ai/dsh' },
    { path: join(dirname(installAnchor), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), name: '@deepseek-ai/dsh' },
    // The VS Code runtime is a dependency-only deploy root: its release line is
    // the base bundle, and no CLI launcher package is installed.
    { path: join(dirname(installAnchor), 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), name: '@deepseek-ai/dsh-base' },
  ]
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate.path, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === candidate.name && typeof manifest.version === 'string' && manifest.version !== '') {
        return manifest.version
      }
    } catch {
      // A missing deploy-root dependency is reported as an unknown runtime version.
    }
  }
  return undefined
}

/**
 * Walk up from the extension to find a source checkout.
 * @param start - absolute directory to search from.
 * @returns the checkout's launcher manifest.
 * @throws when no checkout is found.
 */
function walkForCheckout(start: string): string {
  let dir = start
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, 'apps', 'cli', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'dsh: no installation anchor. Set dsh.runtimePath to a DSH installation, or run from a source checkout.',
  )
}

/**
 * Load one DSH package from the installation that owns it.
 * @param anchor - installation `package.json` used as the resolution root.
 * @param specifier - package specifier to resolve and import.
 * @returns the imported module namespace.
 */
export async function loadFromAnchor<T>(anchor: string, specifier: string): Promise<T> {
  const anchors = [
    anchor,
    // pnpm keeps every installed package addressable from its hoisted module
    // directory, which covers packages no single manifest declares.
    join(dirname(anchor), '..', '..', 'node_modules', '.pnpm', 'node_modules', 'package.json'),
  ]
  const failures: unknown[] = []
  for (const candidate of anchors) {
    try {
      const require = createRequire(candidate)
      const resolved = require.resolve(specifier)
      return await import(pathToFileURL(resolved).href) as T
    } catch (error) {
      failures.push(error)
    }
  }
  throw failures[0]
}

/**
 * Package tooling DSH runs every package operation with. The companion supplies
 * it from its own payload, so install, inspection and version queries never
 * resolve a `pnpm` from `PATH`.
 */
export interface PackageTooling {
  /** pnpm version declared by the staged payload manifest. */
  readonly version: string
  /** Absolute pnpm CLI entry the Node executable runs. */
  readonly entry: string
  /** Node executable that runs the entry. */
  readonly node: string
  /** Environment applied to package operations only. */
  readonly env: Readonly<Record<string, string>>
}

/** Result of locating the staged pnpm payload. */
export type PackageToolingLookup =
  | { readonly tooling: PackageTooling }
  | { readonly problem: string }

/** The pnpm package below one payload root. */
const PNPM_PACKAGE_PATH = join('node_modules', 'pnpm')

/**
 * Locate the pnpm payload a package operation runs from.
 *
 * The standalone runtime stages pnpm below the installation it boots, at
 * `<root>/node_modules/pnpm`; a source checkout supplies it at the workspace
 * root that installs it, which is also two directories above `apps/cli`.
 * @param installAnchor - installation `package.json` this boot resolved.
 * @returns the tooling, or why no payload was found.
 */
export function findPackageTooling(installAnchor: string): PackageToolingLookup {
  if (installAnchor === '') return { problem: 'the installation anchor is unresolved' }
  const problems: string[] = []
  for (const root of payloadRoots(installAnchor)) {
    const packageDir = join(root, PNPM_PACKAGE_PATH)
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) {
      problems.push(`${packageDir} is missing`)
      continue
    }
    let manifest: PnpmManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PnpmManifest
    } catch (error) {
      problems.push(`${manifestPath} is unreadable: ${String(error)}`)
      continue
    }
    const version = typeof manifest.version === 'string' ? manifest.version : ''
    if (version === '') {
      problems.push(`${manifestPath} declares no version`)
      continue
    }
    const declaredEntry = pnpmEntry(manifest)
    if (declaredEntry === undefined) {
      problems.push(`${manifestPath} declares no pnpm CLI entry`)
      continue
    }
    const entry = join(packageDir, declaredEntry)
    if (!existsSync(entry)) {
      problems.push(`${entry} is missing`)
      continue
    }
    const node = packageNode(root)
    return { tooling: { version, entry, node, env: packageEnvironment(node) } }
  }
  return {
    problem: `no packaged pnpm for plugin management (${problems.join('; ')}). `
      + 'Run the apps/vscode runtime:standalone preparation, which stages pnpm below runtime/node_modules, '
      + 'or install pnpm in the configured dsh.runtimePath; package operations do not fall back to a pnpm from PATH.',
  }
}

/**
 * Payload roots that can carry the pnpm package.
 * @param installAnchor - installation `package.json`.
 * @returns candidate roots in search order, without duplicates.
 */
function payloadRoots(installAnchor: string): string[] {
  const installation = dirname(installAnchor)
  // A source checkout anchors on apps/cli/package.json; the workspace root that
  // installs pnpm is two directories above it.
  const roots = basename(installation) === 'cli' && basename(dirname(installation)) === 'apps'
    ? [installation, resolve(installation, '..', '..')]
    : [installation]
  return [...new Set(roots)]
}

/**
 * Read the pnpm CLI entry from a pnpm manifest.
 * @param manifest - staged pnpm manifest.
 * @returns the entry path relative to the package, when it declares one.
 */
function pnpmEntry(manifest: PnpmManifest): string | undefined {
  if (typeof manifest.bin === 'string') return manifest.bin === '' ? undefined : manifest.bin
  const entry = manifest.bin?.pnpm
  return typeof entry === 'string' && entry !== '' ? entry : undefined
}

/**
 * Select the Node executable for package operations.
 * @param root - payload root.
 * @returns the payload's own Node when the runtime stages one, otherwise the
 *   Node this process runs under.
 */
function packageNode(root: string): string {
  const fixed = process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
  for (const file of [recordedNodeFile(root), fixed]) {
    if (file === undefined) continue
    const candidate = join(root, file)
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

/**
 * @param root - payload root.
 * @returns the Node file name the standalone runtime recorded, when it recorded one.
 */
function recordedNodeFile(root: string): string | undefined {
  try {
    const record = JSON.parse(readFileSync(join(root, 'standalone-runtime.json'), 'utf8')) as { nodeFile?: unknown }
    return typeof record.nodeFile === 'string' && record.nodeFile !== '' ? record.nodeFile : undefined
  } catch {
    // A source checkout stages no runtime record; the fixed file names are tried next.
    return undefined
  }
}

/**
 * Environment for package operations: only Node discovery is added, so a
 * lifecycle script resolves the same Node that runs pnpm. Every other variable
 * comes from DSH's scrubbed parent environment.
 * @param node - selected Node executable.
 * @returns the variables this invocation adds.
 */
function packageEnvironment(node: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = { PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}` }
  // An Electron executable runs the payload as plain Node only with this flag;
  // a staged node.exe ignores it.
  if (node === process.execPath && process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** The pnpm manifest fields this module reads. */
interface PnpmManifest {
  version?: unknown
  bin?: string | Record<string, unknown>
}

/**
 * Bundle packages an earlier release shipped and this VS Code composition no
 * longer carries. Voice input is the only such bundle: its distribution
 * removal is a product decision, and a stored selection would be skipped on
 * every start. Other selections stay untouched, including a user bundle whose
 * package is temporarily missing, so an interrupted install remains repairable.
 */
const RETIRED_COMPOSITION_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
])

/**
 * Remove retired bundle names from the extension-owned profile selection.
 * @param profileDir - absolute extension-owned profile directory.
 * @param log - diagnostic sink.
 * @returns the bundle names removed from the stored selection.
 */
export function dropRetiredBundles(profileDir: string, log: (line: string) => void): string[] {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  } catch {
    // An unreadable manifest is reported by profile loading itself.
    return []
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  const kept: string[] = []
  const removed: string[] = []
  for (const name of bundles) {
    if (typeof name !== 'string') continue
    if (RETIRED_COMPOSITION_BUNDLES.has(name)) removed.push(name)
    else kept.push(name)
  }
  if (removed.length === 0) return []
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: kept } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  for (const name of removed) log(`dsh: removed retired profile bundle ${name}`)
  return removed
}

/** The profile manifest fields this module rewrites. */
interface ProfileManifest {
  dsh?: {
    profile?: {
      bundles?: unknown
    }
  }
}

/**
 * Boot one application. The caller owns disposal through `ctx.fiber.dispose()`.
 * @param options - extension location, storage directory, overlay patch, and diagnostic sink.
 * @returns the live context and its profile metadata.
 * @throws when the profile cannot be prepared or a required entry fails to activate.
 */
export async function bootDsh(options: BootDshOptions): Promise<DshApplication> {
  const installAnchor = resolveInstallAnchor(options.extensionPath, options.runtimePath)
  options.log(`dsh: installation anchor ${installAnchor}`)
  // The payload of the installation that boots decides the package tooling; a
  // pnpm from PATH would be an unmanaged second implementation of the same
  // profile operations.
  const resolvedTooling = findPackageTooling(installAnchor)
  if ('problem' in resolvedTooling) throw new Error(`dsh: ${resolvedTooling.problem}`)
  const packageTooling = resolvedTooling.tooling
  options.log(`dsh: package tooling pnpm ${packageTooling.version} (${packageTooling.entry})`)
  // Every DSH package loads from the installation, not from this extension's
  // own location: a VSIX carries no node_modules.
  const appBoot = await loadFromAnchor<typeof import('@deepseek-ai/dsh-app-boot')>(installAnchor, '@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await loadFromAnchor<typeof import('@deepseek-ai/dsh-cmdline')>(installAnchor, '@deepseek-ai/dsh-cmdline')
  const { DSH_LAUNCH_ENVIRONMENT_KEY } = await loadFromAnchor<typeof import('@deepseek-ai/dsh-launch-environment')>(
    installAnchor,
    '@deepseek-ai/dsh-launch-environment',
  )
  const { resolveDshHome } = await loadFromAnchor<typeof import('@deepseek-ai/dsh-home-paths')>(installAnchor, '@deepseek-ai/dsh-home-paths')
  const officialBundles = await loadFromAnchor<typeof import('@deepseek-ai/dsh-official-bundles')>(
    installAnchor,
    '@deepseek-ai/dsh-official-bundles',
  )

  const cwd = options.cwd ?? process.cwd()
  const profileDir = join(options.storageDir, 'profile')
  const rootConfig = join(profileDir, 'cordis.yml')
  if (!existsSync(join(profileDir, 'package.json'))) {
    const template = officialBundles.PROFILE_TEMPLATES['web']
    if (template === undefined) throw new Error('dsh: the shipped web profile template is missing')
    appBoot.initProfile(profileDir, template.bundles)
    options.log(`dsh: initialized profile at ${profileDir}`)
  }
  // An earlier release shipped voice input; this composition does not. Its
  // stored selection would be skipped at load, so drop it once.
  dropRetiredBundles(profileDir, options.log)
  // The whole composition is patch layers over an empty root entry list, so
  // the root file only anchors the Loader's baseUrl at the profile directory.
  writeFileSync(rootConfig, '# dsh profile root: an empty entry list, composed from patches.\n[]\n')
  const profile = appBoot.loadProfileDirectory(NAME, profileDir, installAnchor)
  for (const skipped of profile.skippedBundles) {
    options.log(`dsh: skipped bundle ${skipped.packageName}: ${skipped.reason}`)
  }
  const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile })
  const environment = appBoot.loadLayeredEnv(NAME, cwd, (line) => { options.log(line.trimEnd()) })
  const overlayPaths = [options.overlayPath, ...options.extraOverlays ?? []]
  const profileContext: ProfileContext = {
    name: NAME,
    packageManager: {
      command: packageTooling.node,
      args: [packageTooling.entry],
      env: packageTooling.env,
    },
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor,
    startedBundles: profile.layers.map(layer => layer.packageName),
    cwd,
    home: resolveDshHome(),
    overlayPaths,
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  }
  const patches = appBoot.readProfilePatches(NAME, profileContext, profile)
  // The packaged Skill library lives beside the extension, so it joins the
  // composition as an in-memory row rather than an overlay file.
  patches.push({
    insert: [{
      id: 'vscode-bundled-skills',
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: {
        providerName: 'vscode-bundled-skills',
        includeDefaultRoots: false,
        bundledSkillDir: join(options.extensionPath, 'profile', 'skills'),
        watch: false,
      },
    }],
  })
  const ctx = await appBoot.boot(
    NAME,
    rootConfig,
    patches,
    async (hostCtx) => {
      hostCtx.provide('profileContext', profileContext)
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      await hostCtx.plugin(appBoot.PluginPackages, { resolution })
      provideCmdline(hostCtx, {
        args: [],
        exit: (code) => { options.log(`dsh: the tree requested exit(${String(code)})`) },
        ready: { onReady: () => () => {} },
      })
    },
  )
  // The owner's settings page can inspect local Skill files without changing the agent's sandbox.
  const skillCatalog = ctx.isolate('fs').isolate('skills')
  const skillRegistry = await loadFromAnchor<{ default: new (ctx: Context) => object }>(installAnchor, '@deepseek-ai/dsh-skill')
  const skillFiles = await loadFromAnchor<{ apply(ctx: Context): void }>(installAnchor, '@deepseek-ai/dsh-skill-filesystem')
  await skillCatalog.plugin(skillRegistry.default)
  await skillCatalog.plugin(skillFiles)
  const localSkills = skillCatalog.get('skills') as ExtensionSkillRegistry | undefined
  if (localSkills === undefined) throw new Error('dsh: the local Skill catalog is unavailable')
  registerManagedExtensions(ctx, { cwd, localSkills })
  const loadAnchors = [
    installAnchor,
    ...profile.layers.map(layer => join(layer.packageDir, 'package.json')),
    // pnpm keeps every installed package addressable from its hoisted module
    // directory, which covers packages no single manifest declares.
    join(dirname(installAnchor), '..', '..', 'node_modules', '.pnpm', 'node_modules', 'package.json'),
  ]
  const load = async <T>(specifier: string): Promise<T> => {
    let failure: unknown
    for (const anchor of loadAnchors) {
      try {
        return await loadFromAnchor<T>(anchor, specifier)
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }
  if (options.workspacePath !== undefined) {
    await new WorkspaceRegistration(ctx, options.log).ensure(options.workspacePath)
    options.log(`dsh: workspace bound ${options.workspacePath}`)
  }
  return { ctx, profileDir, installAnchor, load }
}
