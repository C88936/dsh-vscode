/**
 * Boot the VS Code composition and check the bundle inventory the Plugins page
 * reads: voice input is not offered, while the other optional bundles remain.
 *
 * Usage: node --import tsx/esm scripts/composition-smoke.ts [--runtime <dir>]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh } from '../src/host/boot.ts'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeIndex = process.argv.indexOf('--runtime')
const runtimeRoot = runtimeIndex === -1
  ? join(extensionRoot, 'runtime')
  : resolve(process.argv[runtimeIndex + 1] ?? '')
const storage = mkdtempSync(join(tmpdir(), 'dsh-vscode-composition-smoke-'))
const failures: string[] = []
const log = (line: string): void => { process.stdout.write(`${line}\n`) }
const VOICE = '@deepseek-ai/dsh-experimental-voice-input-bundle'

try {
  process.env.DSH_HOME = join(storage, 'home')
  const app = await bootDsh({
    extensionPath: extensionRoot,
    storageDir: storage,
    overlayPath: join(extensionRoot, 'profile', 'vscode.patch.yml'),
    cwd: extensionRoot,
    runtimePath: runtimeRoot,
    log,
  })
  const manager = app.ctx.get('pluginManager') as {
    listBundles(): Promise<{ name: string; optional: boolean; availability: string; enabled: boolean }[]>
  } | undefined
  if (manager === undefined) throw new Error('ctx.pluginManager is unavailable')
  const bundles = await manager.listBundles()
  if (bundles.some(bundle => bundle.name === VOICE)) failures.push(`voice bundle is still offered: ${VOICE}`)
  const optional = bundles.filter(bundle => bundle.optional && bundle.availability === 'installation')
  if (optional.length === 0) failures.push('no optional bundle remains offered')
  if (optional.some(bundle => bundle.enabled)) failures.push('an optional bundle starts enabled')
  log(`bundles: ${String(bundles.length)}; optional offered: ${String(optional.length)}`)
  log(`voice offered: ${String(bundles.some(bundle => bundle.name === VOICE))}`)
  await app.ctx.fiber.dispose()
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  rmSync(storage, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  log('Composition smoke passed')
}
