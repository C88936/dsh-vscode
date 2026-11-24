/**
 * Verify that a local plugin row mounts from a private-network path.
 *
 * The fixture is a real Cordis plugin directory outside the repository, the
 * same shape a LAN deployment mirrors: the generated overlay points at it, and
 * the booted tree must provide what the plugin contributes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'
import { pluginsPatch } from '../src/host/plugins.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const extensionPath = join(here, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-plugin-storage-'))
process.env.DSH_HOME = join(storageDir, 'home')

// A mirrored plugin: one Cordis function plugin contributing a service.
const pluginRoot = mkdtempSync(join(tmpdir(), 'dsh-vscode-plugin-'))
mkdirSync(pluginRoot, { recursive: true })
writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
  name: 'acme-lan-plugin',
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
}, undefined, 2))
writeFileSync(join(pluginRoot, 'index.js'), [
  'export const name = "acme-lan-plugin"',
  'export const inject = []',
  'export function apply(ctx) {',
  '  ctx.provide("acmeLanPlugin", { mounted: true })',
  '}',
  '',
].join('\n'))

const pluginUrl = pathToFileURL(pluginRoot).href
const patch = pluginsPatch([{ id: 'acme-lan-plugin', path: pluginUrl }])
if (patch === undefined) throw new Error('plugin patch was not generated')
const patchPath = join(storageDir, 'plugins-smoke.patch.yml')
writeFileSync(patchPath, patch)

const app = await bootDsh({
  extensionPath,
  storageDir,
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  extraOverlays: [patchPath],
  log: line => { process.stderr.write(`${line}\n`) },
})

const service = app.ctx.get('acmeLanPlugin') as { mounted?: boolean } | undefined
const mounted = service?.mounted === true
process.stdout.write(`local plugin mounted: ${String(mounted)}\n`)

await app.ctx.fiber.dispose()
rmSync(pluginRoot, { recursive: true, force: true })
rmSync(storageDir, { recursive: true, force: true })
process.stdout.write('disposed\n')
if (!mounted) process.exitCode = 1
