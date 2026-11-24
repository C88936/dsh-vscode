/**
 * Boot the VS Code composition with the generated Office overlay and check the
 * bundled Office skills are discoverable and loadable.
 *
 * Usage: node --import tsx/esm scripts/office-smoke.ts [--runtime <dir>]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDsh, resolveInstallAnchor } from '../src/host/boot.ts'
import { officeComposition } from '../src/host/office.ts'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeIndex = process.argv.indexOf('--runtime')
const runtimeRoot = runtimeIndex === -1
  ? join(extensionRoot, 'runtime')
  : resolve(process.argv[runtimeIndex + 1] ?? '')
const node = process.env.DSH_VSCODE_NODE ?? process.execPath
const storage = mkdtempSync(join(tmpdir(), 'dsh-vscode-office-smoke-'))
const failures: string[] = []
const log = (line: string): void => { process.stdout.write(`${line}\n`) }

try {
  process.env.DSH_HOME = join(storage, 'home')
  const installAnchor = resolveInstallAnchor(extensionRoot, runtimeRoot)
  const composition = officeComposition({ installAnchor, node, runtimeRoot })
  if ('reason' in composition) throw new Error(`Office composition unavailable: ${composition.reason}`)
  log(composition.detail)
  const overlay = join(storage, 'office.patch.yml')
  writeFileSync(overlay, composition.patch)

  const app = await bootDsh({
    extensionPath: extensionRoot,
    storageDir: storage,
    overlayPath: join(extensionRoot, 'profile', 'vscode.patch.yml'),
    extraOverlays: [overlay],
    cwd: extensionRoot,
    runtimePath: runtimeRoot,
    log,
  })
  const skills = app.ctx.get('skills') as {
    list(options: { cwd?: string }): Promise<{ name: string }[]>
    get(name: string, options: { cwd?: string }): Promise<{ content: string } | undefined>
  } | undefined
  if (skills === undefined) throw new Error('ctx.skills is unavailable')
  const names = (await skills.list({ cwd: extensionRoot })).map(skill => skill.name)
  const expected = ['office', 'office-docx', 'office-render', 'office-export-pdf']
  for (const name of expected) {
    if (!names.includes(name)) failures.push(`missing Office skill: ${name}`)
  }
  log(`office skills: ${expected.filter(name => names.includes(name)).join(', ')}`)
  const render = await skills.get('office-render', { cwd: extensionRoot })
  if (render === undefined) {
    failures.push('office-render did not load')
  } else if (!render.content.includes('libreofficeKit') || !render.content.includes('cli.js')) {
    failures.push('office-render content has no LibreOffice Kit paths')
  } else {
    log('office-render: LibreOffice Kit paths present')
  }
  const docx = await skills.get('office-docx', { cwd: extensionRoot })
  if (docx === undefined) failures.push('office-docx did not load')
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
  log('Office smoke passed')
}
