/**
 * Build one installable VSIX from a clean checkout.
 *
 * A person who clones this repository should not have to know the internal
 * order of the artifact, runtime and packaging steps, so this script runs them
 * once with explicit prerequisites and stops at the first failure. Every step
 * is the same command the release process runs; nothing is reimplemented here.
 *
 * Usage:
 *   node apps/vscode/scripts/bootstrap-vscode.mjs [--skip-install] [--skip-office]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const { values } = parseArgs({
  options: { 'skip-install': { type: 'boolean' }, 'skip-office': { type: 'boolean' } },
  allowPositionals: false,
})

/** pnpm's Windows launcher is a .cmd shim, which Node refuses to spawn without a shell. */
const PNPM = 'pnpm'
const PNPM_SHELL = process.platform === 'win32'
const PNPM_OPTIONS = PNPM_SHELL ? { shell: true } : {}

/** Smallest supported Node release for this tree. */
const NODE_MINIMUM = [24, 22, 3]

/**
 * Compare two release tuples.
 * @param left - `[major, minor, patch]`.
 * @param right - `[major, minor, patch]`.
 * @returns negative, zero or positive, like a comparator.
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Run one build step with inherited output.
 * @param command - executable.
 * @param args - argument vector.
 */
function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`)
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...(command === PNPM ? PNPM_OPTIONS : {}) })
}

/**
 * Fail with an actionable message when a prerequisite is missing.
 * @param condition - must hold.
 * @param message - what to do instead.
 */
function require(condition, message) {
  if (!condition) throw new Error(`dsh: ${message}`)
}

require(process.platform === 'win32' && process.arch === 'x64',
  `the packaged runtime targets win32-x64; this host is ${process.platform}-${process.arch}`)
const nodeVersion = process.versions.node.split('.').map(Number)
require(compareVersions(nodeVersion, NODE_MINIMUM) >= 0,
  `Node ${NODE_MINIMUM.join('.')} or newer is required, found ${process.versions.node}. Use \`nvm use\`, \`fnm use\`, or install it from nodejs.org.`)
const pnpmVersion = execFileSync(PNPM, ['--version'], { cwd: repoRoot, encoding: 'utf8', ...PNPM_OPTIONS }).trim()
require(pnpmVersion.startsWith('11.'),
  `pnpm 11.x is required (packageManager field), found ${pnpmVersion}. Run \`corepack enable\` or install pnpm 11.`)

if (values['skip-install'] !== true) run(PNPM, ['install'])
run(PNPM, ['run', 'build:artifacts'])
run(PNPM, ['--filter', '@deepseek-ai/dsh-vscode', 'run', 'build'])

const officePayload = join(repoRoot, '.tmp', 'office', 'primary-runtime')
if (values['skip-office'] !== true) {
  run(process.execPath, ['scripts/primary-runtime/prepare.ts', '--target', 'win-x64', '--output', '.tmp/office', '--python-only'])
}
require(existsSync(join(officePayload, 'runtime.json')),
  `the Office authoring payload is missing at ${officePayload}; run without --skip-office, or pass a prepared payload to the runtime step yourself.`)

run(process.execPath, ['apps/vscode/scripts/prepare-standalone-runtime.mjs', '--office-payload', officePayload])
run(PNPM, ['--filter', '@deepseek-ai/dsh-vscode', 'run', 'package:release'])

const vsix = join(repoRoot, 'apps', 'vscode', 'dsh-vscode.vsix')
require(existsSync(vsix), 'the packaging step did not produce apps/vscode/dsh-vscode.vsix')
const bytes = statSync(vsix).size
const digest = createHash('sha256').update(readFileSync(vsix)).digest('hex')
process.stdout.write(`\nready: ${vsix}\n  ${String(Math.round(bytes / 1024 / 1024))} MB\n  sha256 ${digest}\ninstall it with: code --install-extension apps/vscode/dsh-vscode.vsix\n`)
