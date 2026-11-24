/** Release validation for the offline Office authoring interpreter and libraries. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }

/**
 * Command that builds the pinned payload from the repository root. Packaging
 * reports it verbatim so a missing input names its producer instead of failing
 * with a bare `ENOENT`.
 */
export const OFFICE_PAYLOAD_COMMAND = 'node scripts/primary-runtime/prepare.ts --target win-x64 --output .tmp/office --python-only'

/**
 * Require one prepared `primary-runtime` directory before a copy or package
 * step reads it.
 * @param {string} directory - candidate payload directory.
 * @returns {string} the same directory, once its record exists.
 */
export function requireOfficePayloadDirectory(directory) {
  const record = join(directory, 'runtime.json')
  if (!existsSync(record)) {
    throw new Error(
      `dsh: Office authoring payload is missing ${record}; build the pinned payload with \`${OFFICE_PAYLOAD_COMMAND}\` from the repository root, which writes .tmp/office/primary-runtime`,
    )
  }
  return directory
}

/**
 * Require the `primary-runtime` payload below a runtime root.
 * @param {string} root - runtime directory that must carry `primary-runtime/`.
 * @returns {string} the payload directory.
 */
export function requireOfficePayload(root) {
  return requireOfficePayloadDirectory(join(root, 'primary-runtime'))
}

/**
 * Validate the pinned authoring payload and execute its isolated library smoke.
 * No system Python, user site-packages or downloads participate.
 * @param {string} root - managed VS Code runtime directory.
 * @returns {{ python: string, payloadDigest: string }} verified payload identity.
 */
export function verifyOfficePayload(root) {
  const directory = requireOfficePayload(root)
  const manifest = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.python !== lock.pythonVersion
    || !/^[a-f0-9]{64}$/u.test(manifest.payloadDigest)) {
    throw new Error('dsh: Office authoring payload must be the pinned win32-x64 primary runtime')
  }
  for (const [name, version] of Object.entries(lock.pythonPackages)) {
    if (manifest.pythonPackages?.[name] !== version) throw new Error(`dsh: Office authoring payload is missing pinned ${name} ${version}`)
  }
  const python = join(directory, 'dependencies', 'python', 'python.exe')
  if (!statSync(python).isFile()) throw new Error('dsh: Office authoring interpreter is missing')
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|^PYTHON)/iu.test(name)))
  execFileSync(python, ['-I', '-B', '-c',
    'import importlib.metadata as m,json,sys; expected=json.loads(sys.argv[1]); ' +
    'assert all(m.version(k)==v for k,v in expected.items()); ' +
    'import docx,openpyxl,pptx,PIL,lxml.etree,numpy,pandas',
  JSON.stringify(lock.pythonPackages)], { env, stdio: 'pipe', timeout: 120_000 })
  execFileSync(python, ['-I', '-B', fileURLToPath(new URL('./office-roundtrip.py', import.meta.url))],
    { env, stdio: 'pipe', timeout: 120_000 })
  return { python: manifest.python, payloadDigest: manifest.payloadDigest }
}
