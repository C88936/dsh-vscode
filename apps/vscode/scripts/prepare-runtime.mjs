/**
 * Build a portable DSH runtime tree for the extension.
 *
 * `pnpm deploy` produces a self-contained tree, but it omits peer-only
 * workspace packages and leaves vendor packages linked to the checkout. This
 * script completes the closure by copying each missing package from the source
 * workspace, then reports the size.
 *
 * Usage: node scripts/prepare-runtime.mjs [--out <dir>]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const repoRoot = resolve(extensionRoot, '..', '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex === -1 ? join(extensionRoot, '.runtime') : resolve(args[outIndex + 1] ?? '')

process.stdout.write(`runtime target: ${out}\n`)
const skipDeploy = args.includes('--skip-deploy') && existsSync(join(out, 'package.json'))
if (!skipDeploy) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
}

// 1. Deploy the launcher's production dependency tree.
if (!skipDeploy) {
  execFileSync('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', out, '--prod', '--legacy'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  })
}

// 2. Index every workspace package by name so missing peers can be copied.
const sources = sourceIndex()
process.stdout.write(`indexed ${String(sources.size)} workspace packages\n`)

// 3. Complete the peer closure.
const copied = new Set()
for (let round = 0; round < 6; round++) {
  const missing = missingPeers(out)
  const pending = [...missing].filter(name => !copied.has(name))
  if (pending.length === 0) break
  for (const name of pending) {
    const source = sources.get(name)
    if (source === undefined) {
      process.stdout.write(`missing without a source: ${name}\n`)
      continue
    }
    const target = join(out, 'node_modules', ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: path => !/[\\/](node_modules|src|tests|test)([\\/]|$)/u.test(path),
    })
    copied.add(name)
  }
  process.stdout.write(`round ${String(round + 1)}: copied ${String(pending.length)} packages\n`)
}

// 4. Report what the tree still needs and how big it is.
const remaining = [...missingPeers(out)]
process.stdout.write(`unresolved peers: ${remaining.length === 0 ? 'none' : remaining.join(', ')}\n`)
process.stdout.write(`size: ${String(Math.round(directorySize(out) / 1024 / 1024))} MB\n`)
process.stdout.write(`anchor: ${join(out, 'package.json')}\n`)

/**
 * Map package name to its workspace directory.
 * @returns name to directory.
 */
function sourceIndex() {
  const index = new Map()
  const roots = [
    ...readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(repoRoot, 'packages', entry.name)),
    join(repoRoot, 'vendor'),
    join(repoRoot, 'apps'),
  ]
  for (const group of roots) {
    if (!existsSync(group)) continue
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidates = [join(group, entry.name), join(group, entry.name, 'packages')]
      for (const candidate of candidates) collect(candidate, index)
    }
  }
  return index
}

/**
 * @param dir - candidate package directory. @param index - collected map.
 */
function collect(dir, index) {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name === 'string') index.set(manifest.name, dir)
  } catch {
    // A malformed manifest cannot be a copy source.
  }
}

/**
 * Find peer packages the tree cannot resolve locally.
 *
 * pnpm lays packages out under `node_modules/{scope/pkg}` and
 * `node_modules/.pnpm/<id>/node_modules/{scope/pkg}`; walking those two shapes
 * avoids following the junction cycles a general recursion would hit.
 * @param root - runtime directory.
 * @returns missing package names.
 */
function missingPeers(root) {
  const modules = join(root, 'node_modules')
  const manifests = [...scopedManifests(modules)]
  const pnpm = join(modules, '.pnpm')
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(pnpm, entry.name, 'node_modules')
      if (existsSync(nested)) manifests.push(...scopedManifests(nested))
    }
  }
  const missing = new Set()
  for (const manifestPath of manifests) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (existsSync(join(modules, ...name.split('/')))) continue
      if (existsSync(join(modules, '.pnpm', 'node_modules', ...name.split('/')))) continue
      missing.add(name)
    }
  }
  return missing
}

/**
 * List direct and scoped package manifests in one node_modules directory.
 * @param modules - a node_modules directory.
 * @returns manifest paths.
 */
function scopedManifests(modules) {
  const found = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        const manifest = join(path, child.name, 'package.json')
        if (existsSync(manifest)) found.push(manifest)
      }
      continue
    }
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) found.push(manifest)
  }
  return found
}

/**
 * @param dir - directory to measure. @returns total bytes.
 */
function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      total += entry.isDirectory() ? directorySize(path) : statSync(path).size
    } catch {
      // A platform-specific optional package may be a broken junction.
    }
  }
  return total
}
