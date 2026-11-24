/**
 * Package-asset preparation for a carrier with no HTTP route: the bridge reads
 * every exported asset of an active package through the registry, writes it
 * into the launch directory with its media extension, and reports the map so
 * the Webview's synchronous `require.asset` resolves before code runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { MAX_PACKAGE_ASSET_BYTES, WebviewBridge } from '../src/host/bridge.ts'
import { DEFAULT_BRIDGE_LIMITS, type BridgeLimits } from '../src/shared/limits.ts'

interface Frame {
  readonly type: string
  readonly id?: number
  readonly uri?: string
  readonly assets?: Record<string, string>
  readonly error?: string
}

interface PackageFixture {
  readonly assets: Readonly<Record<string, Buffer>>
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const WEBP = Buffer.from('RIFF....WEBP')

/**
 * Reference a built bundle calls `require.asset` with; each path segment is
 * percent-encoded like the build preset encodes it.
 * @param packageName - owning package.
 * @param segments - path segments below `lib/assets`.
 * @returns the document-relative asset reference.
 */
function reference(packageName: string, ...segments: readonly string[]): string {
  return `plugins/${packageName}/assets/${segments.map(segment => encodeURIComponent(segment)).join('/')}`
}

/**
 * Registry double that serves each package's bundle and assets over the same
 * `/plugins` URL space the real registry owns.
 * @param packages - package name mapped to its published assets by path below `lib/assets`.
 * @param missing - asset paths whose read answers 404, as a stale file would.
 */
function fakeRegistry(
  packages: Readonly<Record<string, PackageFixture>>,
  missing: readonly string[] = [],
  comboUrls = false,
): {
  graph(): { entries: { id: string; url: string }[]; batches: never[] }
  packageOf(url: string): string | undefined
  packageAssetReferences(packageName: string): readonly string[]
  fetchBundle(request: Request): Promise<Response>
} {
  return {
    graph: () => ({
      // The real graph publishes every startup bundle as a single-entry combo; the plain form covers carriers that
      // were fed per-package URLs.
      entries: Object.keys(packages).map(name => ({
        id: name,
        url: comboUrls ? `plugins/??${name}/client.js&rev=x` : `/plugins/${name}/client.js`,
      })),
      batches: [],
    }),
    // The real attribution: scoped names, chunks, and single-entry combos.
    packageOf: url => ClientModuleRegistry.prototype.packageOf.call({} as never, url),
    packageAssetReferences: packageName => Object.keys(packages[packageName]?.assets ?? {})
      .map(path => reference(packageName, ...path.split('/'))),
    fetchBundle: async (request) => {
      const parsed = new URL(request.url)
      const path = decodeURIComponent(parsed.pathname)
      // A combo reference's `??` reaches the route through the query part, so the fake reads it the same way.
      const combo = /^\?\?([^,&]+)\/client\.js/u.exec(parsed.search)
      if (combo !== null) return new Response(`// ${combo[1] ?? ''}`)
      const bundle = /^\/plugins\/([^/]+)\/client\.js$/u.exec(path)
      if (bundle !== null) return new Response(`// ${bundle[1] ?? ''}`)
      const asset = /^\/plugins\/([^/]+)\/assets\/(.+)$/u.exec(path)
      if (asset === null || missing.includes(asset[2] ?? '')) return new Response('missing', { status: 404 })
      const bytes = packages[asset[1] ?? '']?.assets[asset[2] ?? '']
      if (bytes === undefined) return new Response('missing', { status: 404 })
      return new Response(bytes)
    },
  }
}

interface Harness {
  readonly bridge: WebviewBridge
  readonly frames: Frame[]
  readonly launchDir: string
  readonly shellRoot: string
  readonly notes: string[]
}

/** One bridge over a real temporary launch directory and the given registry double. */
function harness(registry: ReturnType<typeof fakeRegistry>, limits: BridgeLimits = DEFAULT_BRIDGE_LIMITS): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-asset-bridge-'))
  roots.push(root)
  const shellRoot = join(root, 'shell')
  mkdirSync(shellRoot, { recursive: true })
  writeFileSync(join(shellRoot, 'index.html'), '<script type="module" src="/assets/shell.js"></script>')
  const launchDir = join(root, 'launch', 'activation-1')
  const frames: Frame[] = []
  const notes: string[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'clientModules') return registry
      if (name === 'connection') return { browserPeer: { principal: { kind: 'owner' } } }
      return undefined
    },
    emit: () => {},
  }
  const bridge = new WebviewBridge(
    ctx as never,
    launchDir,
    {
      asUri: path => path,
      postMessage: async (frame) => { frames.push(frame as Frame) },
    },
    line => { notes.push(line) },
    limits,
  )
  return { bridge, frames, launchDir, shellRoot, notes }
}

async function waitFor(frames: readonly Frame[], predicate: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const frame = frames.find(predicate)
    if (frame !== undefined) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for a frame; received ${JSON.stringify(frames)}`)
}

describe('WebviewBridge package assets', () => {
  it('materializes each exported image with its media extension before the shell runs', async () => {
    const registry = fakeRegistry({
      demo: { assets: { 'icon-1.png': PNG, 'nested/a b.webp': WEBP } },
      other: { assets: { 'icon-1.png': Buffer.from([9, 9, 9]) } },
    })
    const { bridge, shellRoot, frames } = harness(registry)
    try {
      const payload = await bridge.prepare(shellRoot)
      expect(payload.assets['/plugins/demo/client.js']).toBeDefined()
      for (const key of [
        reference('demo', 'icon-1.png'),
        reference('demo', 'nested', 'a b.webp'),
        reference('other', 'icon-1.png'),
      ]) {
        expect(payload.assets[key]).toBeDefined()
      }
      const icon = payload.assets[reference('demo', 'icon-1.png')] ?? ''
      const other = payload.assets[reference('other', 'icon-1.png')] ?? ''
      // The same file name in two packages stays two files.
      expect(icon).not.toBe(other)
      expect(readFileSync(icon).equals(PNG)).toBe(true)
      expect(readFileSync(other).equals(Buffer.from([9, 9, 9]))).toBe(true)
      // Assets are served by extension, never as a script file.
      expect(icon.endsWith('.png')).toBe(true)
      expect(payload.assets[reference('demo', 'nested', 'a b.webp')]?.endsWith('.webp')).toBe(true)
      expect(frames).toEqual([])
    } finally {
      bridge.dispose()
    }
  })

  it('removes assets a previous launch of the same directory wrote', async () => {
    const registry = fakeRegistry({ demo: { assets: { 'icon-1.png': PNG } } })
    const { bridge, shellRoot, launchDir } = harness(registry)
    const stale = join(launchDir, 'webview', 'assets', 'stale.png')
    mkdirSync(join(launchDir, 'webview', 'assets'), { recursive: true })
    writeFileSync(stale, PNG)
    try {
      await bridge.prepare(shellRoot)
      expect(existsSync(stale)).toBe(false)
    } finally {
      bridge.dispose()
    }
  })

  it('withholds a package whose declared asset cannot be read', async () => {
    const registry = fakeRegistry(
      { demo: { assets: { 'icon-1.png': PNG, 'icon-2.png': PNG } } },
      ['icon-2.png'],
    )
    const { bridge, shellRoot, notes, frames } = harness(registry)
    try {
      const payload = await bridge.prepare(shellRoot)
      // Every reference the registry reports is declared by the package, so one
      // unreadable file fails the whole package instead of publishing half of it.
      expect(payload.assets[reference('demo', 'icon-1.png')]).toBeUndefined()
      // Its bundle is withheld too, so the page asks for it and learns why.
      expect(payload.assets['/plugins/demo/client.js']).toBeUndefined()
      expect(notes.some(line => line.includes('package assets failed for demo'))).toBe(true)
      await bridge.handle({ type: 'asset', id: 7, url: '/plugins/demo/client.js' })
      const answer = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 7)
      expect(answer.error).toContain('could not be read')
      expect(answer.assets).toBeUndefined()
    } finally {
      bridge.dispose()
    }
  })

  it('refuses a package that publishes more assets than the configured count', async () => {
    const assets: Record<string, Buffer> = {}
    for (let index = 0; index < 3; index++) assets[`icon-${String(index)}.png`] = PNG
    const registry = fakeRegistry({ demo: { assets } })
    const { bridge, shellRoot, notes, frames } = harness(registry, { ...DEFAULT_BRIDGE_LIMITS, packageAssetCount: 2 })
    try {
      const payload = await bridge.prepare(shellRoot)
      // Nothing of the package is published, and its bundle does not execute.
      expect(payload.assets['/plugins/demo/client.js']).toBeUndefined()
      expect(payload.assets[reference('demo', 'icon-0.png')]).toBeUndefined()
      expect(notes.some(line => line.includes('above the 2-asset limit'))).toBe(true)
      await bridge.handle({ type: 'asset', id: 8, url: '/plugins/demo/client.js' })
      const answer = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 8)
      expect(answer.error).toContain('3 assets')
      expect(answer.error).toContain('2-asset limit')
    } finally {
      bridge.dispose()
    }
  })

  it('prepares both packages of a multi-entry startup batch from their own entries', async () => {
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    const registry = fakeRegistry({
      demo: { assets: { 'icon-1.png': PNG } },
      other: { assets: { 'icon-2.svg': SVG } },
    }, [], true)
    const perPackage = registry.graph
    // The real graph also publishes a concatenated bootstrap batch, whose URL names several packages at once.
    registry.graph = () => ({
      ...perPackage(),
      batches: [{
        phase: 'bootstrap' as never,
        url: 'plugins/??demo/client.js,other/client.js&rev=x',
        rev: 'x',
        entries: ['demo', 'other'],
      }],
    })
    const { bridge, shellRoot } = harness(registry)
    try {
      const payload = await bridge.prepare(shellRoot)
      // A concat URL names no single package, but every package keeps its own single-entry row, which is what
      // prepares its assets.
      expect(payload.assets[reference('demo', 'icon-1.png')]).toBeDefined()
      expect(payload.assets[reference('other', 'icon-2.svg')]).toBeDefined()
      expect(Object.keys(payload.assets).some(key => key.includes('??demo/client.js,other/client.js'))).toBe(true)
    } finally {
      bridge.dispose()
    }
  })

  it('prepares a package the graph publishes as a single-entry combo', async () => {
    const registry = fakeRegistry({
      demo: { assets: { 'icon-1.png': PNG } },
      late: { assets: { 'icon-9.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n') } },
    }, [], true)
    const { bridge, shellRoot, frames } = harness(registry)
    try {
      // The real graph names each startup bundle by a combo reference; the carrier must still attribute the package.
      const payload = await bridge.prepare(shellRoot)
      expect(payload.assets, JSON.stringify(payload.assets)).toHaveProperty(reference('demo', 'icon-1.png'))
      await bridge.handle({ type: 'asset', id: 9, url: 'plugins/??late/client.js&rev=x' })
      const answer = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 9)
      expect(answer.error).toBeUndefined()
      expect(answer.assets?.[reference('late', 'icon-9.svg')]).toBeDefined()
    } finally {
      bridge.dispose()
    }
  })

  it('prepares a package first reached by a later chunk and reports its map', async () => {
    const registry = fakeRegistry({
      demo: { assets: { 'icon-1.png': PNG } },
      late: { assets: { 'icon-9.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n') } },
    })
    const { bridge, frames } = harness(registry)
    try {
      await bridge.handle({ type: 'asset', id: 5, url: '/plugins/late/client.js' })
      const answer = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 5)
      expect(answer.error).toBeUndefined()
      expect(answer.uri?.endsWith('.js')).toBe(true)
      expect(answer.assets?.[reference('late', 'icon-9.svg')]).toBeDefined()
    } finally {
      bridge.dispose()
    }
  })

  it('refuses a package whose assets exceed the per-file budget', async () => {
    const oversized = Buffer.alloc(MAX_PACKAGE_ASSET_BYTES + 1, 7)
    const registry = fakeRegistry({ demo: { assets: { 'huge.png': oversized } } })
    const { bridge, shellRoot, notes, frames } = harness(registry)
    try {
      const payload = await bridge.prepare(shellRoot)
      expect(payload.assets[reference('demo', 'huge.png')]).toBeUndefined()
      expect(payload.assets['/plugins/demo/client.js']).toBeUndefined()
      expect(notes.some(line => line.includes('package assets failed for demo'))).toBe(true)
      // A later load of the same package reports the failure instead of
      // executing against a half-prepared map.
      await bridge.handle({ type: 'asset', id: 6, url: '/plugins/demo/client.js' })
      const answer = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 6)
      expect(answer.error).toContain('limit')
    } finally {
      bridge.dispose()
    }
  })
})
