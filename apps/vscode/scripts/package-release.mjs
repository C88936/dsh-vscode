/**
 * Build one standalone VSIX and record the embedded Node and DSH runtime.
 *
 * The VSIX and its embedded DSH runtime carry the same release version.
 *
 * Usage: node scripts/package-release.mjs [--runtime <dir>]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, valid } from 'semver'
import { verifyOfficePayload } from './office-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const args = process.argv.slice(2)
const runtimeIndex = args.indexOf('--runtime')
const runtimePath = runtimeIndex === -1
  ? join(extensionRoot, 'runtime')
  : resolve(args[runtimeIndex + 1] ?? '')

const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'))
const range = typeof manifest.dsh?.runtimeRange === 'string' && manifest.dsh.runtimeRange !== ''
  ? manifest.dsh.runtimeRange
  : undefined
if (!existsSync(runtimePath)) throw new Error(`dsh: release runtime is missing: ${runtimePath}`)
const inspectedRuntime = inspectRuntime(runtimePath, range)
if (!inspectedRuntime.compatible) throw new Error(`dsh: release runtime is incompatible: ${inspectedRuntime.detail}`)
if (valid(manifest.version) !== manifest.version || manifest.version !== inspectedRuntime.version) {
  throw new Error(`dsh: VSIX version ${String(manifest.version)} must match embedded DSH ${String(inspectedRuntime.version)}`)
}
const verifiedRuntime = verifyRuntime(runtimePath, inspectedRuntime)
const office = verifyOfficePayload(runtimePath)

process.stdout.write('building VSIX\n')
execFileSync(process.execPath, [
  join(extensionRoot, 'scripts', 'package-vsix.mjs'),
  '--standalone',
  '--runtime',
  runtimePath,
], { stdio: 'inherit' })
const vsix = join(extensionRoot, 'dsh-vscode.vsix')
const vsixHash = createHash('sha256').update(readFileSync(vsix)).digest('hex')
process.stdout.write(`vsix sha256 ${vsixHash}\n`)

const runtime = runtimeRecord(verifiedRuntime)
const record = {
  generatedAt: new Date().toISOString(),
  extension: {
    version: manifest.version,
    file: 'dsh-vscode.vsix',
    sha256: vsixHash,
    runtimeRange: range ?? null,
  },
  runtime,
  office,
}
const target = join(extensionRoot, 'release.json')
writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
process.stdout.write(`wrote ${target}\n`)

process.stdout.write(`runtime ${runtime.version} embedded with ${runtime.nodeVersion}\n`)
process.stdout.write(`  ${runtime.detail}\n`)

/**
 * Read the verified runtime identity written when the payload was prepared.
 * @param runtime - inspected runtime record.
 * @returns the runtime facts embedded in the VSIX.
 */
function runtimeRecord(runtime) {
  const path = join(runtime.path, 'standalone-runtime.json')
  if (!existsSync(path)) throw new Error(`dsh: release runtime has no standalone-runtime.json: ${runtime.path}`)
  const prepared = JSON.parse(readFileSync(path, 'utf8'))
  if (prepared.runtimeVersion !== runtime.version) {
    throw new Error(`dsh: runtime record names ${String(prepared.runtimeVersion)}, inspected ${String(runtime.version)}`)
  }
  return {
    ...runtime,
    embedded: true,
    platform: prepared.platform,
    arch: prepared.arch,
    nodeVersion: prepared.nodeVersion,
    nodeFile: prepared.nodeFile,
    nodeSha256: prepared.nodeSha256,
  }
}

/**
 * Read a runtime's version and compare it with the declared range, using the
 * same `semver` rule the extension applies at activation.
 * @param dir - runtime directory or source checkout.
 * @param declared - runtime range from the extension manifest.
 * @returns the runtime record.
 */
function inspectRuntime(dir, declared) {
  const manifests = [
    join(dir, 'apps', 'cli', 'package.json'),
    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    // The VS Code composition ships the base bundle and no CLI launcher.
    join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    join(dir, 'package.json'),
  ]
  let version
  for (const manifestPath of manifests) {
    if (!existsSync(manifestPath)) continue
    try {
      // A file saved with a BOM is still a valid manifest for this check.
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/u, ''))
      if ((parsed.name === '@deepseek-ai/dsh' || parsed.name === '@deepseek-ai/dsh-base')
        && typeof parsed.version === 'string') {
        version = parsed.version
        break
      }
    } catch {
      // Another candidate may still name the installed DSH package.
    }
  }
  if (declared === undefined) return { path: dir, version, compatible: true, detail: 'no runtime range declared' }
  if (version === undefined) {
    return { path: dir, version, compatible: false, detail: `runtime version unknown; expected ${declared}` }
  }
  const normalized = valid(version)
  const compatible = normalized !== null && satisfies(normalized, declared, { includePrerelease: true })
  return {
    path: dir,
    version,
    compatible,
    detail: `${version} ${compatible ? 'satisfies' : 'does not satisfy'} ${declared}`,
  }
}

/**
 * Boot the runtime through the companion protocol before recording it as a
 * compatible release input.
 * @param dir - runtime directory or source checkout.
 * @param runtime - version and range facts from inspectRuntime.
 * @returns the runtime record with boot evidence.
 */
function verifyRuntime(dir, runtime) {
  if (!runtime.compatible) return runtime
  process.stdout.write('verifying runtime boot\n')
  const bundledNode = join(dir, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const node = existsSync(bundledNode) ? bundledNode : process.execPath
  execFileSync(process.execPath, [join(extensionRoot, 'scripts', 'companion-smoke.mjs')], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      DSH_VSCODE_RUNTIME: dir,
      DSH_VSCODE_NODE: node,
    },
    stdio: 'inherit',
  })
  return { ...runtime, bootVerified: true }
}
