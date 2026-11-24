/**
 * Minimal deterministic ZIP writer for release artifacts.
 *
 * The repository has no zip dependency, and a VSIX is a zip: both the extension
 * archive and a runtime archive need the same container code.
 * @module @deepseek-ai/dsh-vscode/scripts/zip
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/** CRC-32 lookup table. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/**
 * @param data - bytes. @returns the CRC-32 checksum.
 */
function crc32(data) {
  let crc = -1
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * List every regular file below a directory.
 * @param root - directory to walk.
 * @returns absolute file paths.
 */
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

/**
 * Build one deflate ZIP archive from a directory tree.
 * @param root - directory whose contents become the archive.
 * @param override - optional per-relative-path bytes replacing the file.
 * @returns the archive bytes.
 */
export function zipDirectory(root, override = new Map()) {
  const entries = files(root).map(path => ({ name: relative(root, path).replaceAll('\\', '/'), path }))
  for (const name of override.keys()) {
    if (!entries.some(entry => entry.name === name)) entries.push({ name, path: undefined })
  }
  entries.sort((left, right) => left.name < right.name ? -1 : 1)
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const data = override.get(entry.name) ?? (entry.path === undefined ? Buffer.alloc(0) : readFileSync(entry.path))
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
 * @param path - file to measure. @returns its size in bytes.
 */
export function fileSize(path) {
  return statSync(path).size
}
