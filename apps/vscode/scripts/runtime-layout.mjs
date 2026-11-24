/**
 * Qualified payload selection for the Windows x64 runtime shipped in the VSIX.
 *
 * The deploy root installs every package the VS Code composition loads, including
 * packages whose tarballs carry several operating systems and architectures.
 * Only the win32-x64 payload is reachable at runtime, so debug symbols and
 * foreign prebuild trees are packaging overhead rather than capability. Licenses,
 * notices, Win10 ConPTY helpers, and the win32-x64 binaries stay.
 *
 * Rules are declarative so the same list prunes and re-validates: packaging fails
 * loudly when a required file is gone, a foreign native payload survives, or a
 * foreign prebuild tree reappears under a package without a matching rule.
 */

import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Operating system this runtime payload targets. */
export const RUNTIME_PLATFORM = 'win32'

/** Architecture this runtime payload targets. */
export const RUNTIME_ARCH = 'x64'

/** Debug symbol files that no runtime path loads. */
const DEBUG_SYMBOL = /\.pdb$/iu

/** Native object files whose directory names platform-specific binaries. */
const NATIVE_BINARY = /\.(node|dll|dylib|so)$/iu

/** Directory segments that hold a non-target native payload. */
const FOREIGN_SEGMENT = /^(darwin|linux|freebsd|android|macos|win32-arm64|win32-ia32)(-|$)/iu

/** Package names whose native payload belongs to another operating system or CPU. */
const FOREIGN_PACKAGE = /-(darwin|macos|linux|freebsd|android|win32-(?:arm64|ia32))(?:-|$)/iu

/**
 * One packaging rule: files of `packageName` (or every package) matching `test`
 * are omitted as unreachable for this target.
 * @typedef {object} RuntimeRule
 * @property {string} id - stable rule name recorded in the runtime report.
 * @property {string | null} packageName - npm package the rule applies to, or null for every package.
 * @property {(path: string) => boolean} test - package-relative forward-slash path predicate.
 * @property {string} reason - why the omitted payload is unreachable at runtime.
 */

/** @type {readonly RuntimeRule[]} */
export const RUNTIME_RULES = Object.freeze([
  {
    id: 'debug-symbols',
    packageName: null,
    test: path => DEBUG_SYMBOL.test(path),
    reason: 'Windows program database files are debug symbols; production runs load no debugger and the package licenses stay.',
  },
  {
    id: 'node-pty-foreign-prebuilds',
    packageName: 'node-pty',
    test: path => /^prebuilds\//u.test(path) && !/^prebuilds\/win32-x64\//u.test(path),
    reason: 'node-pty selects one prebuild by process.platform and process.arch; this runtime runs win32-x64 only.',
  },
  {
    id: 'libreoffice-kit-foreign-prebuilds',
    packageName: '@deepseek-ai/libreoffice-kit',
    test: path => /^frame-forwarding\/prebuilds\//u.test(path)
      && !/^frame-forwarding\/prebuilds\/win32-x64\//u.test(path),
    reason: 'The kit resolves one frame-forwarding prebuild by platform and architecture; this runtime runs win32-x64 only.',
  },
])

/**
 * Files the composition needs after pruning. A missing entry fails packaging
 * instead of surfacing as a broken Office, terminal, or editor path at runtime.
 */
const REQUIRED_FILES = Object.freeze([
  'node.exe',
  'package.json',
  'node_modules/@deepseek-ai/dsh-app-boot/package.json',
  'node_modules/@deepseek-ai/dsh-base/package.json',
  'node_modules/@deepseek-ai/dsh-web-app/package.json',
  'node_modules/@deepseek-ai/dsh-official-bundles/package.json',
  'node_modules/@deepseek-ai/dsh-skill-office/package.json',
  'node_modules/@deepseek-ai/dsh-skill-office/assets/office/SKILL.md',
  'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/package.json',
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
])

/** License and attribution files a redistribution must keep. */
const REQUIRED_LICENSES = Object.freeze([
  'node_modules/node-pty/LICENSE',
  'node_modules/@deepseek-ai/libreoffice-kit/LICENSE',
  'node_modules/@deepseek-ai/libreoffice-kit/NOTICE',
])

/**
 * Remove every payload the rules classify as unreachable for this target.
 * @param {string} root - materialized runtime directory.
 * @param {(line: string) => void} log - diagnostic sink for the removed bytes.
 * @returns {{ removedFiles: number, removedBytes: number, byRule: Record<string, { files: number, bytes: number }> }}
 *   what the pruning step omitted.
 */
export function pruneRuntime(root, log = () => {}) {
  const report = { removedFiles: 0, removedBytes: 0, byRule: {} }
  for (const { directory, packageName } of packageDirectories(root)) {
    const files = listFiles(directory)
    for (const file of files) {
      const relativePath = relative(directory, file).split('\\').join('/')
      const rule = RUNTIME_RULES.find(candidate =>
        (candidate.packageName === null || candidate.packageName === packageName) && candidate.test(relativePath))
      if (rule === undefined) continue
      const bytes = sizeOf(file)
      rmFile(file)
      report.removedFiles++
      report.removedBytes += bytes
      const aggregate = report.byRule[rule.id] ?? { files: 0, bytes: 0 }
      aggregate.files++
      aggregate.bytes += bytes
      report.byRule[rule.id] = aggregate
    }
    removeEmptyDirectories(directory)
  }
  for (const { id, reason } of RUNTIME_RULES) {
    const aggregate = report.byRule[id]
    if (aggregate === undefined) continue
    log(`runtime layout: ${id} omitted ${String(aggregate.files)} files (${formatBytes(aggregate.bytes)}); ${reason}`)
  }
  log(`runtime layout: omitted ${String(report.removedFiles)} files (${formatBytes(report.removedBytes)}) in total`)
  return report
}

/**
 * Reject a runtime whose selected payload is incomplete or still carries a
 * foreign platform or architecture.
 * @param {string} root - materialized runtime directory, before or after pruning.
 * @throws {Error} naming every missing file and foreign payload.
 */
export function validateRuntime(root) {
  const failures = []
  for (const path of REQUIRED_FILES) {
    if (!isFile(joinPath(root, path))) failures.push(`missing required file: ${path}`)
  }
  for (const path of REQUIRED_LICENSES) {
    if (!isFile(joinPath(root, path))) failures.push(`missing license or attribution file: ${path}`)
  }
  for (const { directory, packageName } of packageDirectories(root)) {
    for (const file of listFiles(directory)) {
      const relativePath = relative(directory, file).split('\\').join('/')
      if (DEBUG_SYMBOL.test(relativePath)) failures.push(`debug symbol remains: ${packageName}/${relativePath}`)
      if (packageName === 'node-pty' && /^prebuilds\//u.test(relativePath)
        && !/^prebuilds\/win32-x64\//u.test(relativePath)) {
        failures.push(`foreign node-pty prebuild remains: ${relativePath}`)
      }
      if (NATIVE_BINARY.test(relativePath)
        && (relativePath.split('/').some(segment => FOREIGN_SEGMENT.test(segment))
          || FOREIGN_PACKAGE.test(packageName))) {
        failures.push(`foreign native payload remains: ${packageName}/${relativePath}`)
      }
    }
  }
  const links = symbolicLinks(root)
  for (const link of links) failures.push(`symbolic link remains: ${link}`)
  if (failures.length > 0) {
    throw new Error(`dsh: runtime layout validation failed:\n- ${failures.join('\n- ')}`)
  }
}

/**
 * Measure one runtime directory for the release report.
 * @param {string} root - runtime directory.
 * @returns {{ files: number, bytes: number }} regular files and their uncompressed size.
 */
export function measureRuntime(root) {
  let files = 0
  let bytes = 0
  for (const file of listFiles(root)) {
    if (!isFile(file)) continue
    files++
    bytes += sizeOf(file)
  }
  return { files, bytes }
}

/**
 * Every npm package directory below `node_modules`, including nested installs.
 * @param {string} root - runtime directory.
 * @returns {Iterable<{ directory: string, packageName: string }>} package roots.
 */
function* packageDirectories(root) {
  const pending = [joinPath(root, 'node_modules')]
  const seen = new Set()
  while (pending.length > 0) {
    const modules = pending.pop()
    if (modules === undefined || !isDirectory(modules) || seen.has(modules)) continue
    seen.add(modules)
    for (const entry of readdir(modules)) {
      if (!isDirectory(joinPath(modules, entry))) continue
      if (entry.startsWith('@')) {
        for (const child of readdir(joinPath(modules, entry))) {
          const directory = joinPath(modules, entry, child)
          if (!isDirectory(directory)) continue
          yield { directory, packageName: `${entry}/${child}` }
          pending.push(joinPath(directory, 'node_modules'))
        }
        continue
      }
      const directory = joinPath(modules, entry)
      yield { directory, packageName: entry }
      pending.push(joinPath(directory, 'node_modules'))
    }
  }
}

/**
 * @param {string} root - directory to walk. @returns {string[]} every regular file below it.
 */
function listFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue
    let entries
    try {
      entries = readdir(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = joinPath(directory, entry)
      if (isDirectory(path)) pending.push(path)
      else if (isFile(path)) files.push(path)
    }
  }
  return files
}

/**
 * Remove a package's now-empty directories, deepest first.
 * @param {string} directory - package root.
 */
function removeEmptyDirectories(directory) {
  const pending = [directory]
  const emptied = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    for (const entry of readdir(current)) {
      const path = joinPath(current, entry)
      if (isDirectory(path)) pending.push(path)
    }
    emptied.push(current)
  }
  // Deepest first: a parent can become empty only after its children are gone.
  for (const current of emptied.reverse()) {
    if (current === directory) continue
    if (readdir(current).length === 0) rmDirectory(current)
  }
}

/**
 * @param {string} root - directory to inspect. @returns {string[]} every symbolic link below it.
 */
function symbolicLinks(root) {
  const links = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue
    for (const entry of readdir(directory)) {
      const path = joinPath(directory, entry)
      try {
        if (isSymbolicLink(path)) {
          links.push(path)
          continue
        }
      } catch {
        continue
      }
      if (isDirectory(path)) pending.push(path)
    }
  }
  return links
}

/**
 * @param {string} directory - directory to list. @returns {string[]} entry names.
 */
function readdir(directory) {
  try {
    return readDirectory(directory)
  } catch {
    return []
  }
}

/**
 * @param {number} bytes - byte count. @returns {string} a one-decimal MiB or KiB value.
 */
export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}

/** Join path segments without changing their spelling. */
function joinPath(...segments) {
  return join(...segments)
}

/** @param {string} path - candidate. @returns {boolean} whether it is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** @param {string} path - candidate. @returns {boolean} whether it is a directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} path - candidate. @returns {boolean} whether it is a symbolic link. */
function isSymbolicLink(path) {
  return lstatSync(path).isSymbolicLink()
}

/** @param {string} directory - directory to list. @returns {string[]} raw entry names. */
function readDirectory(directory) {
  return readdirSync(directory)
}

/** @param {string} path - file to remove. */
function rmFile(path) {
  rmSync(path, { force: true })
}

/** @param {string} path - directory to remove with its contents. */
function rmDirectory(path) {
  rmSync(path, { recursive: true, force: true })
}

/** @param {string} path - file to measure. @returns {number} its byte length. */
function sizeOf(path) {
  return statSync(path).size
}
