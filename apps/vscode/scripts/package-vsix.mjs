/**
 * Package the extension as a VSIX.
 *
 * The archive carries the extension code, the shipped overlay and the built
 * DSH shell. Standalone packaging additionally requires the managed DSH/Node
 * runtime and the verified offline Office authoring payload.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { satisfies, valid } from 'semver'
import { validateRuntime } from './runtime-layout.mjs'
import { verifyOfficePayload } from './office-payload.mjs'

/** CRC-32 table. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()
const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const repoRoot = resolve(extensionRoot, '..', '..')
const shellRoot = join(repoRoot, 'apps', 'web', 'dist')
const staging = join(extensionRoot, '.vsix-staging')
const output = join(extensionRoot, 'dsh-vscode.vsix')
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'))
const standalone = process.argv.includes('--standalone')
const runtimeIndex = process.argv.indexOf('--runtime')
const runtimeRoot = runtimeIndex === -1
  ? join(extensionRoot, 'runtime')
  : resolve(process.argv[runtimeIndex + 1] ?? '')
if (runtimeIndex !== -1 && !standalone) {
  throw new Error('dsh: --runtime requires --standalone')
}

if (!existsSync(join(shellRoot, 'index.html'))) {
  throw new Error('dsh: apps/web/dist is missing; run pnpm run build:artifacts first')
}
if (standalone && !existsSync(runtimeRoot)) {
  throw new Error('dsh: --standalone requires apps/vscode/runtime with DSH and Node')
}
if (standalone) {
  const node = join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  if (!existsSync(join(runtimeRoot, 'package.json')) || !existsSync(node)) {
    throw new Error('dsh: --standalone requires runtime/package.json and the platform Node executable')
  }
  verifyStandaloneRuntime(runtimeRoot, node, manifest)
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'extension'), { recursive: true })

copyTree(join(extensionRoot, 'lib'), join(staging, 'extension', 'lib'))
copyTree(join(extensionRoot, 'profile'), join(staging, 'extension', 'profile'))
copyTree(join(extensionRoot, 'media'), join(staging, 'extension', 'media'))
copyTree(shellRoot, join(staging, 'extension', 'dist'))
if (existsSync(runtimeRoot)) {
  copyTree(runtimeRoot, join(staging, 'extension', 'runtime'))
} else {
  process.stderr.write('warning: packaging a development VSIX without a managed DSH runtime\n')
}
copyFileSync(join(extensionRoot, 'package.json'), join(staging, 'extension', 'package.json'))
writeFileSync(
  join(staging, 'extension', 'package.json'),
  `${JSON.stringify(packagedManifest(manifest), null, 2)}\n`,
)
copyFileSync(join(extensionRoot, 'README.md'), join(staging, 'extension', 'README.md'))
const license = join(repoRoot, 'LICENSE')
if (existsSync(license)) copyFileSync(license, join(staging, 'extension', 'LICENSE'))

writeFileSync(join(staging, 'extension.vsixmanifest'), vsixManifest(manifest))
writeFileSync(join(staging, '[Content_Types].xml'), contentTypes())

const files = listFiles(staging)
writeFileSync(output, zip(files.map(file => ({ name: relative(staging, file).replaceAll('\\', '/'), path: file }))))
process.stdout.write(`packaged ${String(files.length)} files -> ${output} (${String(Math.round(statSync(output).size / 1024 / 1024))} MB)\n`)


/**
 * Copy one directory tree.
 * @param from - source directory.
 * @param to - destination directory.
 */
function copyTree(from, to) {
  if (!existsSync(from)) throw new Error(`dsh: missing ${from}`)
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true })
      copyTree(source, target)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
  }
}

/**
 * @param root - directory to list. @returns every regular file below it.
 */
function listFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

/**
 * Check that the runtime payload is self-contained, platform-specific, and
 * still matches the release record written by its preparation step.
 * @param root - managed runtime directory.
 * @param node - bundled Node executable.
 * @param extensionManifest - extension manifest declaring the accepted DSH range.
 */
function verifyStandaloneRuntime(root, node, extensionManifest) {
  const record = JSON.parse(readFileSync(join(root, 'standalone-runtime.json'), 'utf8'))
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  if (record.schemaVersion !== 1 || record.platform !== platform || record.arch !== process.arch) {
    throw new Error('dsh: standalone runtime record does not match this platform and architecture')
  }
  const bundledNodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
  if (record.nodeVersion !== bundledNodeVersion || record.nodeFile !== 'node.exe') {
    throw new Error(`dsh: standalone runtime Node record does not match ${bundledNodeVersion}`)
  }
  const nodeHash = createHash('sha256').update(readFileSync(node)).digest('hex')
  if (record.nodeSha256 !== nodeHash) throw new Error('dsh: standalone runtime Node checksum does not match')

  const packageManager = record.packageManager
  if (packageManager?.name !== 'pnpm'
    || typeof packageManager.version !== 'string'
    || typeof packageManager.entry !== 'string') {
    throw new Error('dsh: standalone runtime record has no packaged pnpm payload')
  }
  if (!existsSync(join(root, packageManager.entry))) {
    throw new Error(`dsh: standalone runtime is missing the packaged pnpm entry ${packageManager.entry}`)
  }

  const baseManifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')
  const webAppManifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
  if (!existsSync(baseManifestPath) || !existsSync(webAppManifestPath)) {
    throw new Error('dsh: standalone runtime is missing the DSH base or Web profile bundle')
  }
  const baseManifest = JSON.parse(readFileSync(baseManifestPath, 'utf8'))
  if (baseManifest.name !== '@deepseek-ai/dsh-base' || baseManifest.version !== record.runtimeVersion) {
    throw new Error('dsh: standalone runtime DSH version does not match its release record')
  }
  const dshManifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (existsSync(dshManifestPath)) {
    throw new Error('dsh: the VS Code runtime must not carry the CLI launcher closure')
  }
  if (!existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets', 'office', 'SKILL.md'))) {
    throw new Error('dsh: standalone runtime is missing the bundled Office skills')
  }
  if (!existsSync(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64', 'package.json'))) {
    throw new Error('dsh: standalone runtime is missing the win32-x64 LibreOffice engine')
  }
  const declaredVersion = valid(record.runtimeVersion)
  const range = extensionManifest.dsh?.runtimeRange
  if (declaredVersion === null || typeof range !== 'string'
    || !satisfies(declaredVersion, range, { includePrerelease: true })) {
    throw new Error(`dsh: standalone runtime ${String(record.runtimeVersion)} does not satisfy ${String(range)}`)
  }
  assertRegularTree(root)
  validateRuntime(root)
  verifyOfficePayload(root)
}

/**
 * Reject links so the packaged runtime cannot point into the build machine.
 * @param root - complete runtime payload.
 */
function assertRegularTree(root) {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`dsh: standalone runtime contains a symbolic link: ${path}`)
      if (metadata.isDirectory()) pending.push(path)
    }
  }
}

/**
 * Build the manifest VS Code installs.
 *
 * VS Code derives the extension identity from a slash-free `publisher.name`,
 * so the packaged manifest drops the workspace scope and the development-only
 * sections.
 * @param manifest - workspace extension manifest.
 * @returns the packaged manifest.
 */
function packagedManifest(manifest) {
  return {
    name: 'dsh-vscode',
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    publisher: manifest.publisher,
    license: manifest.license,
    private: true,
    type: 'module',
    main: manifest.main,
    engines: manifest.engines,
    categories: manifest.categories,
    dsh: manifest.dsh,
    activationEvents: manifest.activationEvents,
    contributes: manifest.contributes,
  }
}

/**
 * @param manifest - extension manifest. @returns the VSIX XML.
 */
function vsixManifest(manifest) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="dsh-vscode" Version="${manifest.version}" Publisher="${manifest.publisher}" />
    <DisplayName>${escapeXml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(manifest.description)}</Description>
    <Tags>ai,agent,deepseek</Tags>
    <Categories>${(manifest.categories ?? []).join(',')}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

/** @returns the content-type map covering every payload extension. */
function contentTypes() {
  const extensions = ['.json', '.js', '.cjs', '.mjs', '.map', '.css', '.html', '.svg', '.png', '.webp', '.woff', '.woff2', '.ttf', '.md', '.txt', '.yml', '.yaml', '.wasm', '.exe', '.node', '.dll', '.so', '.dylib', '.vsixmanifest', '.xml']
  const rows = extensions.map((extension) => {
    const type = extension === '.vsixmanifest' || extension === '.xml'
      ? 'text/xml'
      : extension === '.json' || extension === '.map'
        ? 'application/json'
        : extension === '.css'
          ? 'text/css'
          : extension === '.html'
            ? 'text/html'
            : extension === '.svg'
              ? 'image/svg+xml'
              : extension === '.png'
                ? 'image/png'
                : extension === '.md'
                  ? 'text/markdown'
                  : 'application/octet-stream'
    return `  <Default Extension="${extension}" ContentType="${type}"/>`
  })
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${rows.join('\n')}
</Types>
`
}

/**
 * @param text - raw text. @returns XML-escaped text.
 */
function escapeXml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Build a store-less deflate ZIP archive.
 * @param entries - archive members with forward-slash names.
 * @returns the complete archive bytes.
 */
function zip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const data = statSync(entry.path).isDirectory() ? Buffer.alloc(0) : readFileSync(entry.path)
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, compressed)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, directory, end])
}



/**
 * @param data - bytes. @returns the CRC-32 checksum.
 */
function crc32(data) {
  let crc = -1
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}
