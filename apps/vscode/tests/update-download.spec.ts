/**
 * Download verification: a VSIX reaches the version-named path only after its size and SHA-256 match the feed, and
 * every refused response, oversized body, and cancelled signal leaves no artifact behind.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadUpdate, type OpenDownloadFile } from '../src/host/update/download.ts'
import { parseUpdateManifest, type UpdateManifest } from '../src/host/update/manifest.ts'

const directories: string[] = []
const servers: (() => Promise<void>)[] = []

/** @returns a fresh directory that the suite removes. */
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-vscode-update-'))
  directories.push(directory)
  return directory
}

/**
 * @param body - VSIX bytes the server returns.
 * @returns the served URL and a closer for the loopback listener.
 */
async function serve(body: Uint8Array): Promise<string> {
  const path = '/dsh-vscode-0.2.0.vsix'
  const server = createServer((request, response) => {
    if (request.url !== path) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-length': String(body.byteLength) })
    response.end(Buffer.from(body))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server bound no port')
  return `http://127.0.0.1:${String(address.port)}${path}`
}

/**
 * @param url - download address.
 * @param body - bytes the feed describes.
 * @param overrides - feed fields the case changes.
 * @returns one validated feed.
 */
function manifestFor(url: string, body: Uint8Array, overrides: Record<string, unknown> = {}): UpdateManifest {
  const result = parseUpdateManifest(JSON.stringify({
    schemaVersion: 'dsh-vscode-update/v1',
    extensionId: 'deepseek-ai.dsh-vscode',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
    targetPlatform: 'universal',
    url,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.byteLength,
    publishedAt: '2026-11-19T12:00:00.000Z',
    ...overrides,
  }))
  if (!result.ok) throw new Error(result.problem.detail)
  return result.manifest
}

/** @param directory - update directory. @returns its file names. */
function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}

afterEach(async () => {
  for (const close of servers.splice(0)) await close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('downloadUpdate', () => {
  it('publishes a verified VSIX under the version-named path', async () => {
    const body = new TextEncoder().encode('vsix payload for the intranet update')
    const manifest = manifestFor(await serve(body), body)
    const directory = join(workspace(), 'updates')

    const result = await downloadUpdate({ manifest, directory })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.downloaded.sha256).toBe(manifest.sha256)
    expect(result.downloaded.size).toBe(body.byteLength)
    expect(result.downloaded.path).toBe(join(directory, 'dsh-vscode-0.2.0.vsix'))
    expect(statSync(result.downloaded.path).size).toBe(body.byteLength)
    expect(new Uint8Array(readFileSync(result.downloaded.path))).toEqual(body)
    expect(listing(directory)).toEqual(['dsh-vscode-0.2.0.vsix'])
  })

  it('removes the staged file when the digest does not match', async () => {
    const body = new Uint8Array(24).fill(1)
    const other = new Uint8Array(24).fill(2)
    const manifest = manifestFor(await serve(body), other)
    const directory = workspace()

    const result = await downloadUpdate({ manifest, directory })

    expect(result).toMatchObject({ ok: false, failure: { code: 'digest-mismatch' } })
    expect(listing(directory)).toEqual([])
  })

  it('refuses a response larger than the feed declares', async () => {
    const body = new TextEncoder().encode('a longer payload than promised')
    const promised = new TextEncoder().encode('short')
    const manifest = manifestFor(await serve(body), promised)
    const directory = workspace()

    const result = await downloadUpdate({ manifest, directory })

    expect(result).toMatchObject({ ok: false, failure: { code: 'size-mismatch' } })
    expect(listing(directory)).toEqual([])
  })

  it('refuses a declared size above the download cap without sending a request', async () => {
    const body = new TextEncoder().encode('payload')
    const requested: string[] = []
    const fetchDouble: typeof globalThis.fetch = async (input) => {
      requested.push(String(input))
      return await new Response(body)
    }

    const result = await downloadUpdate({
      manifest: manifestFor('https://updates.lan/dsh.vsix', body),
      directory: workspace(),
      maxBytes: 4,
      fetch: fetchDouble,
    })

    expect(result).toMatchObject({ ok: false, failure: { code: 'too-large' } })
    expect(requested).toEqual([])
  })

  it('refuses a download whose signal is already aborted', async () => {
    const body = new TextEncoder().encode('payload')
    const abort = new AbortController()
    abort.abort()
    let fetched = 0

    const result = await downloadUpdate({
      manifest: manifestFor('https://updates.lan/dsh.vsix', body),
      directory: workspace(),
      signal: abort.signal,
      fetch: async () => {
        fetched += 1
        return await new Response(body)
      },
    })

    expect(result).toMatchObject({ ok: false, failure: { code: 'cancelled' } })
    expect(fetched).toBe(0)
  })

  it('stops while streaming when the signal aborts and removes the staged file', async () => {
    const body = new TextEncoder().encode('streamed payload that is interrupted')
    const manifest = manifestFor('https://updates.lan/dsh.vsix', body)
    const directory = workspace()
    const abort = new AbortController()
    const openFile: OpenDownloadFile = async () => ({
      write: async () => { abort.abort() },
      close: async () => {},
    })
    const fetchDouble: typeof globalThis.fetch = async () => await new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 4))
        controller.enqueue(body.subarray(4))
        controller.close()
      },
    }))

    const result = await downloadUpdate({ manifest, directory, signal: abort.signal, fetch: fetchDouble, openFile })

    expect(result).toMatchObject({ ok: false, failure: { code: 'cancelled' } })
    expect(listing(directory)).toEqual([])
  })

  it('reports an unreachable origin and leaves no file', async () => {
    const body = new TextEncoder().encode('payload')

    const result = await downloadUpdate({
      manifest: manifestFor('https://updates.lan/dsh.vsix', body),
      directory: workspace(),
      fetch: async () => { throw new TypeError('fetch failed') },
    })

    expect(result).toMatchObject({ ok: false, failure: { code: 'request-failed' } })
    expect(result.ok ? '' : result.failure.detail).toContain('fetch failed')
  })

  it('refuses an address the feed rule rejects, even when the manifest was built elsewhere', async () => {
    const body = new TextEncoder().encode('payload')
    const manifest = { ...manifestFor('https://updates.lan/dsh.vsix', body), url: 'http://updates.lan/dsh.vsix' }
    let fetched = 0

    const result = await downloadUpdate({
      manifest,
      directory: workspace(),
      fetch: async () => {
        fetched += 1
        return await new Response(body)
      },
    })

    expect(result).toMatchObject({ ok: false, failure: { code: 'url' } })
    expect(fetched).toBe(0)
  })
})
