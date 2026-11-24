/**
 * Host side of the webview transport.
 *
 * The extension owns no HTTP listener: unary calls go to the same shared Fetch
 * handler the Web carrier mounts at `/api`, logical streams go to the Typert
 * gateway's in-process opener, and client bundles are materialized from the
 * module registry's own reader into this activation's launch directory.
 * @module @deepseek-ai/dsh-vscode/host/bridge
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { removeStaleBundles, removeStaleFiles } from './webview-cache.ts'
import { DEFAULT_BRIDGE_LIMITS, type BridgeLimits } from '../shared/limits.ts'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Boot payload the webview needs before it can run the DSH shell. */
export interface WebviewBootPayload {
  /** Structured index injection rows, exactly as the Web carrier would render them. */
  readonly injections: readonly unknown[]
  /** Materialized bundle URLs mapped to the webview URIs that serve them. */
  readonly assets: Readonly<Record<string, string>>
  /** Webview URI of the shell entry module. */
  readonly shell: string
  /** Webview URIs of the shell stylesheets, in document order. */
  readonly styles: readonly string[]
  /** Bounded-transfer budgets the page enforces; the Host enforces the same record. */
  readonly limits: BridgeLimits
}

/**
 * Largest response body one opt-in binary Webview answer carries, in bytes.
 * This is the default of `dsh.limits.binaryResponseBytes`: the plugin-detail
 * image routes serve at most 5 MiB, so the default bounds a transfer that would
 * otherwise cross the JSON message channel unbounded.
 */
export const MAX_BINARY_RESPONSE_BYTES = DEFAULT_BRIDGE_LIMITS.binaryResponseBytes

/** Largest number of package assets one package may contribute to one launch. */
export const MAX_PACKAGE_ASSETS_PER_PACKAGE = DEFAULT_BRIDGE_LIMITS.packageAssetCount

/** Largest single package asset copied into the launch directory, in bytes. */
export const MAX_PACKAGE_ASSET_BYTES = DEFAULT_BRIDGE_LIMITS.packageAssetBytes

/** Largest total of package assets copied into one launch directory, in bytes. */
export const MAX_PACKAGE_ASSET_TOTAL_BYTES = DEFAULT_BRIDGE_LIMITS.packageAssetTotalBytes

/** One text answer, the default every Webview fetch receives. */
export interface TextFetchAnswer {
  /** HTTP status of the Host response. */
  readonly status: number
  /** The response body as text. */
  readonly body: string
}

/** One opt-in binary answer: the response bytes and the media type the Host served. */
export interface BinaryFetchAnswer {
  /** HTTP status of the Host response. */
  readonly status: number
  /** The response body bytes, base64-encoded for the JSON message channel. */
  readonly base64: string
  /** The response `Content-Type`, or `application/octet-stream` when the Host named none. */
  readonly contentType: string
}

/** The answer to one Webview `fetch` request. */
export type FetchAnswer = TextFetchAnswer | BinaryFetchAnswer

/** Host service behind the changed-files card's summary and file comparisons. */
interface WorkspaceChangesFetchService {
  summary(sessionId: string, seq: number): unknown
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal, options?: { readonly full?: boolean }): Promise<unknown>
}

/** The webview surface this bridge needs; the view owns the VS Code specifics. */
export interface WebviewHost {  /**
   * Map an absolute filesystem path to a URL the webview may load.
   * @param path - absolute path below an allowed resource root.
   * @returns the webview-loadable URL.
   */
  asUri(path: string): string
  /**
   * Deliver one frame to the webview.
   * @param message - JSON-serializable frame.
   * @returns settles when the frame reached the webview.
   */
  postMessage(message: unknown): PromiseLike<unknown>
}

/** Per-window state one bridge may override. */
export interface WebviewBridgeOptions {
  /**
   * Peer scoped to this window connection. A shared host gives every connection
   * its own peer so page injections and access checks see that window; a
   * per-window companion keeps the single browser peer.
   */
  readonly peer?: PeerScope
  /**
   * Absolute directory holding materialized bundles and package assets. A
   * shared host gives every connection its own directory, so one window's stale
   * cleanup cannot delete a file another window is serving.
   */
  readonly resourceDir?: string
}

/** One logical stream owned by the webview. */
interface OpenStream {
  readonly controller: AbortController
  readonly uplink: AsyncItemQueue<unknown>
}

/** One streamed upload owned by the webview. */
interface OpenUpload {
  readonly controller: AbortController
  readonly body: ReadableStreamDefaultController<Uint8Array>
  readonly demand: DemandGate
}

/**
 * One-chunk flow control for an upload body. The Webview sends the next chunk
 * only after the previous one was acknowledged, and an acknowledgement waits
 * until the fetch body's own consumer asks for more, so a slow route cannot
 * make the bridge buffer an unbounded upload. The first credit arrives from the
 * stream's initial pull; aborting, ending, or disposing the upload releases a
 * waiter so a request that stopped reading cannot leave the frame handler
 * suspended.
 */
class DemandGate {
  private available = 0
  private failure: unknown
  private wake: (() => void) | undefined

  /** Record that the body consumer is ready for one more chunk. */
  arrive(): void {
    this.available++
    this.signal()
  }

  /** Wait for the consumer's next request for data. */
  async next(): Promise<void> {
    while (this.available === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    this.available--
  }

  /** Release every waiter; later waits throw. @param error - why the body stopped. */
  close(error: unknown): void {
    this.failure = error
    this.signal()
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** Messages the webview sends. */
type WebviewMessage =
  | {
    type: 'fetch'
    id: number
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    /** Opt into the binary answer; every caller without it keeps the text answer. */
    binary?: boolean
  }
  | { type: 'fetch-cancel'; id: number }
  | { type: 'upload-open'; id: number; url: string; method?: string; headers?: Record<string, string> }
  | { type: 'upload-chunk'; id: number; seq: number; data: string }
  | { type: 'upload-end'; id: number; seq: number }
  | { type: 'upload-cancel'; id: number }
  | { type: 'stream-open'; id: number; endpoint: string; payload: unknown }
  | { type: 'stream-item-send'; id: number; seq: number; item: unknown }
  | { type: 'stream-end-send'; id: number; seq: number }
  | { type: 'stream-cancel'; id: number }
  | { type: 'asset'; id: number; url: string }
  | { type: 'log'; line: string }

/** In-process transport for one webview. */
export class WebviewBridge {
  private readonly streams = new Map<number, OpenStream>()
  private readonly fetches = new Map<number, AbortController>()
  private readonly uploads = new Map<number, OpenUpload>()
  private readonly assetRootDir: string
  private readonly bundlesDir: string
  private readonly packageAssetsDir: string
  private readonly assets = new Map<string, string>()
  private closed = false
  /** Bundle file names this boot graph materialized, for stale-cache cleanup. */
  private readonly materializedFiles = new Set<string>()
  /** Package-asset file names this launch wrote, for stale-cache cleanup. */
  private readonly materializedAssetFiles = new Set<string>()
  /** Prepared asset URIs per package, keyed by package name. */
  private readonly assetsByPackage = new Map<string, Readonly<Record<string, string>>>()
  /** One in-flight preparation per package, so a boot and a later chunk share it. */
  private readonly preparing = new Map<string, Promise<void>>()
  /** Bytes copied into {@link packageAssetsDir} by this launch. */
  private packageAssetBytes = 0

  /**
   * @param ctx - live DSH root context.
   * @param launchDir - launch directory this activation owns; bundles are
   * materialized below it, so no other window shares or cleans their files.
   * @param host - the webview this bridge serves.
   * @param log - diagnostic sink.
   * @param limits - bounded-transfer budgets read from the deployment settings.
   */
  constructor(
    private readonly ctx: Context,
    launchDir: string,
    private readonly host: WebviewHost,
    private readonly log: (line: string) => void,
    private readonly limits: BridgeLimits = DEFAULT_BRIDGE_LIMITS,
    private readonly options: WebviewBridgeOptions = {},
  ) {
    this.assetRootDir = options.resourceDir ?? join(launchDir, 'webview')
    this.bundlesDir = join(this.assetRootDir, 'bundles')
    this.packageAssetsDir = join(this.assetRootDir, 'assets')
  }

  /** Absolute directory holding this launch's materialized client bundles. */
  get resourceDir(): string {
    return this.assetRootDir
  }

  /**
   * Materialize every composed client bundle and build the boot payload.
   * @param shellRoot - built Web frontend directory (`apps/web/dist`).
   * @returns the payload the webview document embeds.
   */
  async prepare(shellRoot: string): Promise<WebviewBootPayload> {
    const registry = this.registry()
    const graph = registry.graph()
    const urls = new Set<string>()
    for (const entry of graph.entries) urls.add(entry.url)
    for (const batch of graph.batches) urls.add(batch.url)
    const failures: string[] = []
    await Promise.all([...urls].map(async (url) => {
      try {
        await this.materialize(registry, url)
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
    for (const failure of failures) this.log(`dsh: bundle unavailable ${failure}`)
    const stale = removeStaleBundles(this.bundlesDir, this.materializedFiles)
    if (stale > 0) this.log(`dsh: removed ${String(stale)} stale webview bundle(s)`)
    const packages = new Set<string>()
    for (const url of urls) {
      const packageName = registry.packageOf(url)
      if (packageName !== undefined) packages.add(packageName)
    }
    const failed = new Set<string>()
    await Promise.all([...packages].map(async (packageName) => {
      try {
        await this.preparePackageAssets(packageName)
      } catch (error) {
        failed.add(packageName)
        this.log(`dsh: package assets failed for ${packageName}: ${describe(error)}; its bundles are withheld`)
      }
    }))
    // A package whose assets are incomplete is withheld from the boot payload:
    // the page then asks for its bundle and receives this failure, so one plugin
    // reports why it could not load instead of executing against missing assets.
    if (failed.size > 0) {
      for (const url of urls) {
        const owner = registry.packageOf(url)
        if (owner !== undefined && failed.has(owner)) this.assets.delete(url)
      }
    }
    const staleAssets = removeStaleFiles(this.packageAssetsDir, this.materializedAssetFiles)
    if (staleAssets > 0) this.log(`dsh: removed ${String(staleAssets)} stale package asset(s)`)
    const entries = await this.shellEntries(shellRoot)
    return {
      injections: this.injections(),
      assets: Object.fromEntries(this.assets),
      shell: this.host.asUri(entries.shell),
      styles: entries.styles.map(style => this.host.asUri(style)),
      limits: this.limits,
    }
  }

  /**
   * Handle one webview message.
   * @param message - the decoded message envelope.
   */
  async handle(message: unknown): Promise<void> {
    const frame = message as WebviewMessage
    switch (frame.type) {
      case 'fetch': {
        const binary = frame.binary === true
        const controller = new AbortController()
        this.fetches.set(frame.id, controller)
        try {
          const answer = await this.fetch(frame.url, frame.method, frame.headers, frame.body, controller.signal, binary)
          await this.post({ type: 'fetch-result', id: frame.id, ...answer })
        } catch (error) {
          if (!controller.signal.aborted) {
            const failure = JSON.stringify({ error: describe(error) })
            await this.post(binary
              ? {
                  type: 'fetch-result',
                  id: frame.id,
                  status: 500,
                  base64: encodeBase64(Buffer.from(failure, 'utf8')),
                  contentType: 'application/json',
                }
              : { type: 'fetch-result', id: frame.id, status: 500, body: failure })
          }
        } finally {
          this.fetches.delete(frame.id)
        }
        return
      }
      case 'fetch-cancel': {
        this.fetches.get(frame.id)?.abort()
        this.fetches.delete(frame.id)
        return
      }
      case 'upload-open': {
        const controller = new AbortController()
        const demand = new DemandGate()
        let body: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start: (next) => { body = next },
          // The stream asks for its next chunk only after the fetch body's
          // consumer took the previous one, so one chunk stays in flight.
          pull: () => { demand.arrive() },
          cancel: () => {
            demand.close(new Error('DSH upload stream cancelled'))
            controller.abort()
          },
        })
        if (body === undefined) throw new Error('dsh: upload stream did not initialize')
        this.uploads.set(frame.id, { controller, body, demand })
        void this.openUpload(frame.id, frame.url, frame.method, frame.headers, stream, controller.signal)
        return
      }
      case 'upload-chunk': {
        const upload = this.uploads.get(frame.id)
        if (upload !== undefined && !upload.controller.signal.aborted) {
          let ready = true
          try {
            await upload.demand.next()
          } catch {
            // The body stopped before the consumer asked for this chunk; the
            // result frame, not this acknowledgement, settles the sender.
            ready = false
          }
          if (ready && !upload.controller.signal.aborted) {
            try {
              upload.body.enqueue(new Uint8Array(Buffer.from(frame.data, 'base64')))
            } catch {
              // The response settled while this chunk was in flight.
            }
          }
        }
        await this.post({ type: 'upload-ack', id: frame.id, seq: frame.seq })
        return
      }
      case 'upload-end': {
        const upload = this.uploads.get(frame.id)
        if (upload !== undefined && !upload.controller.signal.aborted) {
          upload.demand.close(new Error('DSH upload body ended'))
          try {
            upload.body.close()
          } catch {
            // The stream already reached a terminal state.
          }
        }
        await this.post({ type: 'upload-ack', id: frame.id, seq: frame.seq })
        return
      }
      case 'upload-cancel': {
        const upload = this.uploads.get(frame.id)
        upload?.demand.close(new Error('DSH upload cancelled'))
        upload?.controller.abort()
        try {
          upload?.body.error(new Error('DSH upload cancelled'))
        } catch {
          // A completed or cancelled stream cannot accept another terminal signal.
        }
        this.uploads.delete(frame.id)
        return
      }
      case 'stream-open': {
        const controller = new AbortController()
        const uplink = new AsyncItemQueue<unknown>()
        this.streams.set(frame.id, { controller, uplink })
        void this.openStream(frame.id, frame.endpoint, frame.payload, controller.signal, uplink)
        return
      }
      case 'stream-item-send': {
        const stream = this.streams.get(frame.id)
        stream?.uplink.push(frame.item)
        await this.post({ type: 'stream-uplink-ack', id: frame.id, seq: frame.seq })
        return
      }
      case 'stream-end-send': {
        const stream = this.streams.get(frame.id)
        stream?.uplink.end()
        await this.post({ type: 'stream-uplink-ack', id: frame.id, seq: frame.seq })
        return
      }
      case 'stream-cancel': {
        this.streams.get(frame.id)?.controller.abort()
        this.streams.get(frame.id)?.uplink.cancel(new Error('DSH stream cancelled'))
        this.streams.delete(frame.id)
        return
      }
      case 'asset': {
        try {
          const registry = this.registry()
          await this.materialize(registry, frame.url)
          // A bundle that boot did not name belongs to a package prepared here,
          // so its images are in the map before the script executes.
          const packageName = registry.packageOf(frame.url)
          if (packageName !== undefined) await this.preparePackageAssets(packageName)
          await this.post({
            type: 'asset-result',
            id: frame.id,
            uri: this.assets.get(frame.url),
            ...packageName === undefined ? {} : { assets: this.assetsByPackage.get(packageName) ?? {} },
          })
        } catch (error) {
          await this.post({ type: 'asset-result', id: frame.id, error: describe(error) })
        }
        return
      }
      case 'log':
        this.log(frame.line)
        return
      default:
        this.log(`unhandled webview message ${JSON.stringify(message)}`)
    }
  }

  /** Abort every logical stream this webview owned. */
  dispose(): void {
    this.closed = true
    for (const stream of this.streams.values()) {
      stream.controller.abort()
      stream.uplink.cancel(new Error('DSH Webview disposed'))
    }
    this.streams.clear()
    for (const controller of this.fetches.values()) controller.abort()
    this.fetches.clear()
    for (const upload of this.uploads.values()) {
      upload.demand.close(new Error('DSH Webview disposed'))
      upload.controller.abort()
    }
    this.uploads.clear()
  }

  private async fetch(
    url: string,
    method: string | undefined,
    headers: Readonly<Record<string, string>> | undefined,
    body: BodyInit | undefined,
    signal: AbortSignal,
    binary: boolean,
  ): Promise<FetchAnswer> {
    const connection = this.connection()
    if (!binary) {
      const changes = await this.fetchWorkspaceChanges(url, signal)
      if (changes !== undefined) return changes
    }
    const handler = connection.createSharedFetchHandler('/api')
    const request = new Request(new URL(url, 'http://dsh.local'), {
      method: method ?? 'POST',
      headers: headers ?? { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body },
      signal,
      ...body instanceof ReadableStream ? { duplex: 'half' as const } : {},
    })
    const response = await handler.fetch(request, this.peer())
    if (binary) {
      if (!response.ok) {
        this.log(`dsh: Webview binary request failed ${method ?? 'POST'} ${url}: HTTP ${String(response.status)}`)
      }
      const bytes = await readBoundedBody(response, this.limits.binaryResponseBytes)
      return {
        status: response.status,
        base64: encodeBase64(bytes),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      }
    }
    const responseBody = await response.text()
    const failure = remoteFailureSummary(responseBody)
    if (!response.ok || failure !== undefined) {
      this.log(`dsh: Webview request failed ${method ?? 'POST'} ${url}: ${failure ?? `HTTP ${String(response.status)}`}`)
    }
    return { status: response.status, body: responseBody }
  }

  /**
   * Serve the changed-files summary and comparison routes from the Host
   * service. The desktop Web profile registers these on its HTTP server; the
   * VS Code surface has no listener, so the page's fetch needs this bridge.
   * @param url - Webview fetch URL.
   * @param signal - cancels a comparison read.
   * @returns the text answer, or undefined for every other route.
   */
  private async fetchWorkspaceChanges(url: string, signal: AbortSignal): Promise<TextFetchAnswer | undefined> {
    const parsed = new URL(url, 'http://dsh.local')
    if (parsed.pathname !== '/api/changes.summary' && parsed.pathname !== '/api/changes.diff') return undefined
    const service = this.ctx.get('workspaceChanges') as WorkspaceChangesFetchService | undefined
    const sessionId = parsed.searchParams.get('sessionId') ?? ''
    const seq = Number(parsed.searchParams.get('seq'))
    if (service === undefined || sessionId === '' || !Number.isSafeInteger(seq)) {
      return { status: 404, body: JSON.stringify({ error: 'workspace changes are unavailable' }) }
    }
    try {
      if (parsed.pathname === '/api/changes.summary') {
        const summary = service.summary(sessionId, seq)
        return summary === undefined
          ? { status: 404, body: JSON.stringify({ error: 'no summary for this turn' }) }
          : { status: 200, body: JSON.stringify(summary) }
      }
      const index = Number(parsed.searchParams.get('index'))
      if (!Number.isSafeInteger(index)) return { status: 400, body: JSON.stringify({ error: 'index is required' }) }
      const full = parsed.searchParams.get('full') === '1'
      const diff = await service.diff(sessionId, seq, index, signal, { full })
      return diff === undefined
        ? { status: 404, body: JSON.stringify({ error: 'no comparison for this file' }) }
        : { status: 200, body: JSON.stringify(diff) }
    } catch (error) {
      return { status: 500, body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }
    }
  }

  private async openUpload(
    id: number,
    url: string,
    method: string | undefined,
    headers: Readonly<Record<string, string>> | undefined,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const answer = await this.fetch(url, method ?? 'POST', headers, body, signal, false)
      await this.post({ type: 'upload-result', id, ...answer })
    } catch (error) {
      if (!signal.aborted) {
        await this.post({
          type: 'upload-result',
          id,
          status: 500,
          body: JSON.stringify({ error: describe(error) }),
        })
      }
    } finally {
      this.uploads.get(id)?.demand.close(new Error('DSH upload finished'))
      this.uploads.delete(id)
    }
  }

  private async openStream(
    id: number,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink: AsyncItemQueue<unknown>,
  ): Promise<void> {
    try {
      const gateway = this.gateway()
      const values = await gateway.wireStream.open(endpoint, payload, uplink, this.peer(), signal)
      for await (const item of values) {
        if (signal.aborted) break
        await this.post({ type: 'stream-item', id, item })
      }
      uplink.end()
      await this.post({ type: 'stream-end', id })
    } catch (error) {
      uplink.cancel(error)
      let failure = { code: 'gateway/internal', message: describe(error) }
      try {
        const reported = this.gateway().wireStream.failure(error)
        failure = { code: reported.code, message: reported.message }
      } catch (formatError) {
        this.log(`dsh: stream failure could not be classified: ${describe(formatError)}`)
      }
      try {
        await this.post({ type: 'stream-end', id, error: failure })
      } catch (postError) {
        // The Webview can close while a failed stream is being reported.
        this.log(`dsh: stream failure could not reach the Webview: ${describe(postError)}`)
      }
    } finally {
      this.streams.delete(id)
    }
  }

  private async materialize(registry: ClientModuleRegistry, url: string): Promise<void> {
    if (this.assets.has(url)) return
    if (this.closed) throw new Error('dsh: the webview bundle directory is closed')
    const response = await registry.fetchBundle(new Request(new URL(url, 'http://dsh.local'), { method: 'GET' }))
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    // Combo URLs carry `??` and `&rev=`, which are not file names on every
    // platform: the file is named by its content, and the URL stays the key.
    // The name stays URL-derived; only the directory is launch-scoped, because
    // a shared directory would let one window's stale-cache cleanup delete a
    // bundle another window is serving.
    const name = createHash('sha256').update(url).digest('hex').slice(0, 16)
    const target = join(this.bundlesDir, `${name}.js`)
    mkdirSync(this.bundlesDir, { recursive: true })
    writeFileSync(target, bytes)
    this.materializedFiles.add(basename(target))
    this.assets.set(url, this.host.asUri(target))
  }

  /**
   * Materialize every supported asset one active package publishes, so the
   * Webview's synchronous `require.asset` can answer before the package's code
   * runs. A package is prepared once per launch; a failure is not cached, so a
   * later request retries it.
   * @param packageName - active package name.
   */
  private async preparePackageAssets(packageName: string): Promise<void> {
    const pending = this.preparing.get(packageName)
    if (pending !== undefined) return await pending
    const started = this.materializePackageAssets(packageName)
    this.preparing.set(packageName, started)
    try {
      await started
    } catch (error) {
      this.preparing.delete(packageName)
      throw error
    }
  }

  /**
   * Copy one package's published assets into this launch directory.
   *
   * Each reference is read through {@link ClientModuleRegistry.fetchBundle}, so
   * the package's `./assets/*` export, the media type, and the path rules are
   * enforced by the owning registry rather than by this adapter. The whole
   * package succeeds or nothing is published: every reference the registry
   * reported is declared by the package, so an unreadable, oversized, or
   * over-budget asset is a failure rather than a file to skip.
   * @param packageName - active package name.
   * @throws when an asset cannot be read, the count exceeds the configured
   * limit, or the size budgets are exceeded.
   */
  private async materializePackageAssets(packageName: string): Promise<void> {
    const registry = this.registry()
    const references = registry.packageAssetReferences(packageName)
    // The count is checked before anything is read, so an oversized package
    // cannot spend the launch budget on work whose result is discarded.
    if (references.length > this.limits.packageAssetCount) {
      throw new Error(
        `${packageName} publishes ${String(references.length)} assets, above the `
        + `${String(this.limits.packageAssetCount)}-asset limit`,
      )
    }
    const prepared: Record<string, string> = {}
    let copied = 0
    for (const reference of references) {
      const existing = this.assets.get(reference)
      if (existing !== undefined) {
        prepared[reference] = existing
        continue
      }
      const response = await registry.fetchBundle(new Request(new URL(reference, 'http://dsh.local'), { method: 'GET' }))
      if (!response.ok) {
        throw new Error(`the declared asset ${reference} could not be read: HTTP ${String(response.status)}`)
      }
      const bytes = await readBoundedBody(response, this.limits.packageAssetBytes)
      copied += bytes.byteLength
      if (this.packageAssetBytes + copied > this.limits.packageAssetTotalBytes) {
        throw new Error(
          `the package assets exceed the ${String(this.limits.packageAssetTotalBytes)}-byte launch budget`,
        )
      }
      const target = this.packageAssetFile(reference)
      mkdirSync(this.packageAssetsDir, { recursive: true })
      writeFileSync(target, bytes)
      this.materializedAssetFiles.add(basename(target))
      prepared[reference] = this.host.asUri(target)
    }
    // The launch budget counts only bytes a package actually published, so a
    // failed attempt does not charge the same files twice on a retry.
    this.packageAssetBytes += copied
    for (const [reference, uri] of Object.entries(prepared)) this.assets.set(reference, uri)
    this.assetsByPackage.set(packageName, prepared)
  }

  /**
   * Name the launch-directory file of one package asset.
   *
   * The name is derived from the reference, so two packages that publish the
   * same file name never collide, and the extension is preserved because the
   * Webview serving the file infers its media type from it.
   * @param reference - document-relative asset reference.
   * @returns the absolute target path below {@link packageAssetsDir}.
   */
  private packageAssetFile(reference: string): string {
    const dot = reference.lastIndexOf('.')
    const extension = dot < 0 ? '' : reference.slice(dot).toLowerCase()
    return join(this.packageAssetsDir, `${createHash('sha256').update(reference).digest('hex').slice(0, 16)}${extension}`)
  }

  /**
   * Build the page injection table the way the served Web carrier does: one
   * `webserver/index-inject` emit lets every host row push its current rows
   * (module-system bootstrap, theme, shortcuts, onboarding options) for this
   * page's peer. Calling `bootInjections` directly would omit those globals.
   * @returns the rows the webview applies before the shell loads.
   */
  private injections(): readonly unknown[] {
    return pageInjections(this.ctx, this.peer())
  }

  /** Webview URIs of the shell entry module and its stylesheets. */
  private async shellEntries(shellRoot: string): Promise<{ shell: string; styles: string[] }> {
    const html = readFileSync(join(shellRoot, 'index.html'), 'utf8')
    const script = /<script[^>]+type="module"[^>]+src="([^"]+)"/u.exec(html)?.[1]
    if (script === undefined) throw new Error('dsh: the built Web shell has no module entry')
    const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)]
      .map(match => join(shellRoot, match[1] ?? ''))
    return { shell: join(shellRoot, script.replace(/^\//u, '')), styles }
  }

  private registry(): ClientModuleRegistry {
    const registry = this.ctx.get('clientModules') as ClientModuleRegistry | undefined
    if (registry === undefined) throw new Error('dsh: ctx.clientModules is unavailable')
    return registry
  }

  private connection(): HostConnectionHandle {
    const connection = this.ctx.get('connection') as HostConnectionHandle | undefined
    if (connection === undefined) throw new Error('dsh: ctx.connection is unavailable')
    return connection
  }

  /**
   * @returns the peer this window connection uses: the one a shared host created
   * for it, or the single browser peer of a per-window companion.
   */
  private peer(): PeerScope {
    return this.options.peer ?? this.connection().browserPeer
  }

  private gateway(): TypertGateway {
    const gateway = this.ctx.get('typertGateway') as TypertGateway | undefined
    if (gateway === undefined) throw new Error('dsh: ctx.typertGateway is unavailable')
    return gateway
  }

  private async post(message: unknown): Promise<void> {
    await this.host.postMessage(message)
  }
}

/**
 * Collect the page injection rows for one webview peer.
 *
 * The VS Code page is composed by the same host rows the served Web app uses;
 * emitting their event here keeps the bootstrap, theme, shortcuts, and
 * onboarding globals in one place instead of duplicating the module-system
 * rows in the extension.
 * @param ctx - live DSH root context.
 * @param peer - the webview's browser peer.
 * @returns rows in push order.
 */
export function pageInjections(ctx: Context, peer: PeerScope): readonly unknown[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, peer)
  return table
}

/** One-consumer async queue for client-to-host stream items. */
class AsyncItemQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private ended = false
  private failure: unknown
  private wake: (() => void) | undefined

  /** @param value - item to publish. */
  push(value: T): void {
    if (this.ended) return
    this.values.push(value)
    this.signal()
  }

  /** Finish the queue after already published items. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** Fail the queue and wake any pending reader. @param error - terminal failure. */
  cancel(error: unknown): void {
    if (this.ended) return
    this.failure = error
    this.ended = true
    this.signal()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T
        continue
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** Client module registry surface this bridge reads. */
interface ClientModuleRegistry {
  graph(): WebBootGraph
  fetchBundle(request: Request): Promise<Response>
  /**
   * @param url - bundle URL the graph published.
   * @returns the package that owns it, or undefined for a non-package URL.
   */
  packageOf(url: string): string | undefined
  /**
   * @param packageName - active package name.
   * @returns the document-relative references of every asset it publishes.
   */
  packageAssetReferences(packageName: string): readonly string[]
}

/** Typert gateway surface this bridge reads. */
interface TypertGateway {
  readonly wireStream: {
    open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown> | undefined,
      peer: PeerScope,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
    failure(error: unknown): { code: string; message: string; details?: object }
  }
}

/**
 * Encode response bytes for the Webview message channel.
 * @param bytes - response body bytes.
 * @returns base64 text.
 */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Read one response body without exceeding a byte budget. The declared
 * `Content-Length` is checked first, then every chunk, so an oversize response
 * stops before its bytes are encoded for the Webview.
 * @param response - the response to read.
 * @param maxBytes - largest accepted body.
 * @returns the complete body.
 * @throws when the body, or the length it declares, exceeds `maxBytes`.
 */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`the response declares ${String(declared)} bytes, above the ${String(maxBytes)}-byte limit`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`the response body exceeds the ${String(maxBytes)}-byte limit`)
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extract a bounded server failure summary without logging request or response values.
 * @param body - encoded server response.
 * @returns the stable error code and message, or undefined for a successful response.
 */
function remoteFailureSummary(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value === 'object' && value !== null) {
      if ('ok' in value && value.ok === true) return undefined
      if (!('result' in value)) return 'unclassified failure body'
      const result = value.result
      if (typeof result === 'object' && result !== null && 'error' in result) {
        const error = result.error
        if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error
          && typeof error.code === 'string' && typeof error.message === 'string') {
          return `${error.code}: ${error.message.slice(0, 500)}`
        }
      }
      if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === true) return undefined
    }
  } catch {
    return 'non-JSON failure body'
  }
  return 'unclassified failure body'
}
