/**
 * Regenerate the deploy root's dependency list from the composition closure.
 *
 * The runtime deploy uses a hoisted, non-workspace-hoisting linker, so every
 * workspace package the composition reaches must be a direct dependency of
 * this root. The closure starts at the two shipped bundles plus the rows this
 * extension adds, then follows workspace dependencies.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', '..')
const deployPath = join(root, 'apps', 'vscode', 'deploy', 'package.json')

/** @returns {Map<string, { manifest: any, kind: 'packages' | 'vendor' }>} */
function workspacePackages() {
  const map = new Map()
  for (const group of readdirSync(join(root, 'packages'))) {
    const groupDir = join(root, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir)) {
      const manifestPath = join(groupDir, name, 'package.json')
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        map.set(manifest.name, { manifest, kind: 'packages' })
      } catch {}
    }
  }
  for (const name of readdirSync(join(root, 'vendor'))) {
    const manifestPath = join(root, 'vendor', name, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      map.set(manifest.name, { manifest, kind: 'vendor' })
    } catch {}
  }
  return map
}

const packages = workspacePackages()
const deploy = JSON.parse(readFileSync(deployPath, 'utf8'))
const seeds = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
for (const name of Object.keys(deploy.dependencies)) {
  if (packages.has(name)) seeds.push(name)
}

const closure = new Set()
const queue = [...seeds]
while (queue.length > 0) {
  const name = queue.pop()
  if (closure.has(name) || !packages.has(name)) continue
  closure.add(name)
  const { manifest } = packages.get(name)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (packages.has(dep) && !closure.has(dep)) queue.push(dep)
    }
  }
}

const dependencies = {}
for (const name of [...closure].sort()) {
  dependencies[name] = packages.get(name).kind === 'vendor' ? 'workspace:~' : 'workspace:*'
}
deploy.dependencies = dependencies
writeFileSync(deployPath, `${JSON.stringify(deploy, null, 2)}\n`)
process.stdout.write(`deploy closure: ${String(closure.size)} workspace packages\n`)
