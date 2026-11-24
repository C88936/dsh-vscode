/**
 * Assemble and verify one platform-specific runtime for a standalone VSIX.
 *
 * The staged payload also carries the repository-installed pnpm, so plugin
 * management runs from the installation's own tooling instead of `PATH`. The
 * Office authoring payload is not a package dependency, so it is staged from
 * `--office-payload` or reused from the previous runtime; a missing payload
 * fails before the deploy runs.
 *
 * Usage:
 *   node scripts/prepare-standalone-runtime.mjs [--runtime <dir>] [--node <node.exe>]
 *     [--office-payload <primary-runtime directory>]
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { measureRuntime, pruneRuntime, validateRuntime } from './runtime-layout.mjs'
import {
  OFFICE_PAYLOAD_COMMAND,
  requireOfficePayload,
  requireOfficePayloadDirectory,
  verifyOfficePayload,
} from './office-payload.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionRoot = resolve(here, '..')
const repoRoot = resolve(extensionRoot, '..', '..')
// The extension ships the VS Code composition, not the CLI launcher: the
// launcher declares optional bundles (voice input among them) whose capability
// rows this product never mounts, so its closure would be dead payload.
const closureName = '@deepseek-ai/dsh-vscode-runtime'
const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    node: { type: 'string' },
    'office-payload': { type: 'string' },
  },
  allowPositionals: false,
})
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`standalone runtime preparation currently supports win32-x64 only, received ${process.platform}-${process.arch}`)
}

// Resolve the Office input first: it is not part of the deploy closure, and the
// deploy below takes long enough that a missing payload must fail before it.
const officeInput = resolveOfficeInput(values.runtime, values['office-payload'])
const deployedSource = values.runtime === undefined ? await deployRuntimeClosure() : undefined
const source = deployedSource ?? resolve(values.runtime)
const nodeSource = resolve(values.node ?? process.execPath)
const target = join(extensionRoot, 'runtime')
const staging = mkdtempSync(join(extensionRoot, '.runtime-staging-'))
const backup = `${target}.previous`

try {
  assertRuntimeLayout(source)
  if (!existsSync(nodeSource) || !statSync(nodeSource).isFile()) {
    throw new Error(`standalone Node executable does not exist: ${nodeSource}`)
  }
  const runtimeVersion = installedDshVersion(source)
  const nodeVersion = execFileSync(nodeSource, ['--version'], { encoding: 'utf8' }).trim()
  assertSupportedNode(nodeVersion)

  process.stdout.write(`copying runtime ${runtimeVersion} from ${source}\n`)
  cpSync(source, staging, {
    recursive: true,
    dereference: true,
    filter: path => (source === target || resolve(path) !== target)
      && !path.includes(`${join(extensionRoot, '.runtime-staging-')}`),
  })
  const stagedNode = join(staging, 'node.exe')
  cpSync(nodeSource, stagedNode)
  if (officeInput !== undefined) {
    // Never merge a new interpreter with an older installation's libraries.
    rmSync(join(staging, 'primary-runtime'), { recursive: true, force: true })
    cpSync(officeInput, join(staging, 'primary-runtime'), { recursive: true, dereference: true })
  }
  // Plugin management resolves pnpm from the staged payload, never from PATH.
  const pnpm = stagePnpmPayload(staging)
  const office = verifyOfficePayload(staging)
  assertNoLinks(staging)
  const layout = pruneRuntime(staging, line => { process.stdout.write(`${line}\n`) })
  validateRuntime(staging)
  const measured = measureRuntime(staging)
  process.stdout.write(
    `selected win32-x64 payload: ${String(measured.files)} files, ${String(measured.bytes)} bytes uncompressed\n`,
  )
  writeFileSync(join(staging, 'standalone-runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    runtimeVersion,
    nodeVersion,
    nodeFile: basename(stagedNode),
    nodeSha256: hashFile(stagedNode),
    packageManager: pnpm,
    office,
    layout: {
      removedFiles: layout.removedFiles,
      removedBytes: layout.removedBytes,
      files: measured.files,
      bytes: measured.bytes,
      byRule: layout.byRule,
    },
  }, undefined, 2)}\n`)

  process.stdout.write('verifying staged runtime boot\n')
  // The smoke's own storage sits inside the extension root: the companion runs
  // the sandbox rooted at its workspace, and a storage directory under the
  // system temp root makes Windows ACL preparation depend on that path.
  const smokeStorage = join(extensionRoot, '.tmp', 'companion-smoke')
  mkdirSync(smokeStorage, { recursive: true })
  try {
    execFileSync(process.execPath, [join(extensionRoot, 'scripts', 'companion-smoke.mjs')], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        DSH_VSCODE_RUNTIME: staging,
        DSH_VSCODE_NODE: stagedNode,
        DSH_VSCODE_STORAGE: smokeStorage,
      },
      stdio: 'inherit',
    })
  } finally {
    rmSync(smokeStorage, { recursive: true, force: true })
  }

  rmSync(backup, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, backup)
  try {
    renameSync(staging, target)
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, target)
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
  process.stdout.write(`standalone runtime ready: ${target}\n`)
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  throw error
} finally {
  if (deployedSource !== undefined) rmSync(deployedSource, { recursive: true, force: true })
}

/**
 * Select the `primary-runtime` directory the staged runtime carries.
 *
 * The pnpm deploy closure installs only the composition's package dependencies,
 * and the Office authoring payload is generated outside every package, so the
 * closure never contains it. Without `--office-payload`, the payload installed
 * with the previous runtime is the input: a rebuild then reuses the pinned
 * interpreter instead of failing after staging.
 * @param {string | undefined} runtimeSource - explicit `--runtime` directory.
 * @param {string | undefined} requested - explicit `--office-payload` directory.
 * @returns {string | undefined} the payload directory, or undefined when the
 *   runtime source already carries `primary-runtime/runtime.json`.
 */
function resolveOfficeInput(runtimeSource, requested) {
  if (requested !== undefined) return requireOfficePayloadDirectory(resolve(requested))
  const source = runtimeSource === undefined ? undefined : resolve(runtimeSource)
  if (source !== undefined && existsSync(join(source, 'primary-runtime', 'runtime.json'))) return undefined
  const installed = join(extensionRoot, 'runtime')
  const installedPayload = join(installed, 'primary-runtime')
  if (existsSync(join(installedPayload, 'runtime.json'))) {
    process.stdout.write(`reusing the installed Office payload from ${installedPayload}\n`)
    return requireOfficePayload(installed)
  }
  throw new Error(
    `standalone runtime preparation requires the pinned Office payload: pass --office-payload <primary-runtime directory>, `
    + `build it with \`${OFFICE_PAYLOAD_COMMAND}\` from the repository root, or leave a prepared payload at ${installedPayload}; `
    + `the pnpm deploy closure for ${closureName} carries no primary-runtime`,
  )
}

/**
 * Deploy the production dependency closure without accepting an unfinished
 * workspace tree as the runtime.
 * @returns the temporary deployed runtime directory.
 */
async function deployRuntimeClosure() {
  const pnpm = join(repoRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(pnpm)) throw new Error(`standalone runtime deployment requires ${pnpm}`)
  const output = mkdtempSync(join(tmpdir(), 'dsh-vscode-runtime-deploy-'))
  try {
    process.stdout.write(`deploying ${closureName} to ${output}\n`)
    await waitForChild(process.execPath, [
      pnpm,
      '--filter',
      closureName,
      'deploy',
      '--legacy',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      '--config.allow-unused-patches=true',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      // Keep the deploy root's own layout: hoisting workspace packages made
      // pnpm emit a cyclic link chain through the Cordis peers, which cannot be
      // materialized into a runtime directory.
      '--config.hoist-workspace-packages=false',
      output,
    ], {
      cwd: repoRoot,
    })
    return output
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}

/**
 * Wait for one child process with a bounded lifetime.
 * @param command - executable path.
 * @param args - argument vector.
 * @param options - cwd for the child.
 */
function waitForChild(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      windowsHide: true,
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 15 * 60 * 1000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        rejectPromise(new Error(`runtime deployment exceeded 15 minutes`))
        return
      }
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`runtime deployment exited with code ${String(code)} signal ${String(signal)}`))
    })
  })
}

/**
 * Require the deploy root and the Web profile bundle the extension boots.
 * @param root - runtime directory.
 */
function assertRuntimeLayout(root) {
  for (const relative of [
    'package.json',
    join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    join('node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'),
    join('node_modules', '@deepseek-ai', 'dsh-skill-office', 'package.json'),
  ]) {
    if (!existsSync(join(root, relative))) throw new Error(`standalone runtime is missing ${relative}: ${root}`)
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-vscode-runtime' && manifest.name !== '@deepseek-ai/dsh-vscode-runtime') {
    throw new Error(`standalone runtime is not the VS Code composition: ${String(manifest.name)}`)
  }
}

/**
 * @param root - deployed runtime directory.
 * @returns the installed DSH version, read from the release-line base bundle
 *   because this composition ships no CLI launcher.
 */
function installedDshVersion(root) {
  const path = join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh-base' || typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`installed base runtime manifest has an invalid identity: ${path}`)
  }
  return manifest.version
}

/**
 * Copy the repository-installed pnpm into the staging directory and validate
 * the entry and version before the runtime is published. The companion resolves
 * this fixed location, so a missing entry or a version other than the pinned
 * one fails preparation instead of surfacing as a broken package operation.
 * @param root - staging directory.
 * @returns the recorded name, version, and CLI entry, relative to the runtime.
 */
function stagePnpmPayload(root) {
  const source = join(repoRoot, 'node_modules', 'pnpm')
  const manifestPath = join(source, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`standalone runtime preparation requires the repository-installed pnpm at ${manifestPath}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const expected = repositoryPnpmVersion()
  if (manifest.version !== expected) {
    throw new Error(
      `the repository-installed pnpm is ${String(manifest.version)}, but the root manifest pins pnpm@${expected}`,
    )
  }
  const cli = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm
  if (typeof cli !== 'string' || cli === '') {
    throw new Error(`the pnpm payload declares no pnpm CLI entry: ${manifestPath}`)
  }
  // pnpm is a workspace link here; the copy materializes the package contents.
  const target = join(root, 'node_modules', 'pnpm')
  cpSync(source, target, { recursive: true, dereference: true })
  const stagedEntry = join(target, cli)
  if (!existsSync(stagedEntry)) throw new Error(`the staged pnpm CLI entry is missing: ${stagedEntry}`)
  const staged = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  if (staged.version !== expected) {
    throw new Error(`the staged pnpm reports ${String(staged.version)}; expected ${expected}`)
  }
  const entry = `node_modules/pnpm/${cli.split('\\').join('/')}`
  process.stdout.write(`staged pnpm ${expected} at ${entry}\n`)
  return { name: 'pnpm', version: expected, entry }
}

/**
 * @returns the pnpm version the repository manifest pins in `packageManager`.
 */
function repositoryPnpmVersion() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const declared = typeof manifest.packageManager === 'string' ? /^pnpm@(.+)$/u.exec(manifest.packageManager) : null
  if (declared === null) {
    throw new Error('the repository manifest declares no pnpm packageManager, so the payload has no expected version')
  }
  return declared[1]
}

/**
 * @param version - output of the bundled Node executable's `--version`.
 */
function assertSupportedNode(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (match === null) throw new Error(`standalone Node reported an unexpected version: ${version}`)
  const [, majorText, minorText] = match
  const major = Number.parseInt(majorText, 10)
  const minor = Number.parseInt(minorText, 10)
  if (major < 24 || major === 24 && minor < 9) {
    throw new Error(`standalone Node must be version 24.9 or newer, received ${version}`)
  }
}

/**
 * Reject symlinks and junctions so the runtime cannot escape its payload.
 * @param root - fully materialized runtime directory.
 */
function assertNoLinks(root) {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`standalone runtime contains a symbolic link: ${path}`)
      if (metadata.isDirectory()) pending.push(path)
    }
  }
}

/**
 * @param path - file to hash.
 * @returns its SHA-256 digest.
 */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
