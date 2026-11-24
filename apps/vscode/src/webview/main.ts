/**
 * Webview-side bootstrap.
 *
 * It installs the transport the DSH client reads (`__DSH_TRANSPORT__`), applies
 * the host's boot injection table, then loads the DSH shell bundle. Every
 * browser-to-Host call travels over `postMessage`; no HTTP server, socket, or
 * iframe participates.
 * @module @deepseek-ai/dsh-vscode/webview
 */
import { DEFAULT_BRIDGE_LIMITS, readBridgeLimits, type BridgeLimits } from '../shared/limits.ts'

/** Subset of the Webview API this bootstrap uses. */
interface WebviewApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: Record<string, unknown>): void
}

/** One boot injection row, as produced by the Host's client-module registry. */
type InjectionRow =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement?: 'head' | 'body'; text: string }
  | { kind: 'script-src'; placement?: 'head' | 'body'; src: string }
  | { kind: 'script-preload'; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement?: 'head' | 'body'; html: string }

/** Host-to-webview frames. */
type HostFrame =
  | { type: 'fetch-result'; id: number; status: number; body: string }
  | { type: 'fetch-result'; id: number; status: number; base64: string; contentType: string }
  | { type: 'upload-result'; id: number; status: number; body: string }
  | { type: 'upload-ack'; id: number; seq: number }
  | { type: 'stream-item'; id: number; item: unknown }
  | { type: 'stream-end'; id: number; error?: { code: string; message: string } }
  | { type: 'stream-uplink-ack'; id: number; seq: number }
  | {
    type: 'asset-result'
    id: number
    uri?: string
    /** Assets prepared beside the requested bundle, as webview URIs. */
    assets?: Record<string, string>
    error?: string
  }
  | { type: 'transport-reset'; reason: string; deliberate?: boolean }
  | { type: 'open-result'; id: number; ok: boolean; error?: string }
  | { type: 'restart-result'; id: number; ok: boolean; error?: string }
  | { type: 'set-provider-model-result'; id: number; ok: boolean; error?: string }
  | { type: 'pick-result'; id: number; path?: string; reason?: 'cancelled' | 'unsupported' | 'failed'; detail?: string }
  | { type: 'dsh-command'; command: 'session.new' | 'session.search' | 'session.fork' }
  | { type: 'log'; line: string }

/** One resource or URL the DSH client asks the extension host to open. */
interface HostOpenRequest {
  readonly address: string
  readonly path?: string
  readonly line?: number
}

/** Boot payload the extension embeds in the document. */
interface BootPayload {
  readonly injections: InjectionRow[]
  readonly assets: Readonly<Record<string, string>>
  readonly nonce: string
  readonly shell: string
  /** Limits this page enforces; absent means the defaults. */
  readonly limits?: unknown
}

/** One text answer to a unary Host request. */
type TextAnswer = { readonly status: number; readonly body: string }

/** One opt-in binary answer to a unary Host request. */
type BinaryAnswer = { readonly status: number; readonly base64: string; readonly contentType: string }

/** The answer to one unary Host request. */
type FetchAnswer = TextAnswer | BinaryAnswer

const globals = globalThis as Record<string, unknown>
/** The Webview API; assigned by {@link start} before any transport call. */
let api: WebviewApi
/** The page's transport; assigned by {@link start} before the shell requests anything. */
let transport: WebviewTransport | undefined
/** Materialized bundle URLs from the boot payload. */
let assets: Readonly<Record<string, string>> = {}
/** CSP nonce for the scripts this bootstrap appends. */
let nonce = ''

let nextId = 1
const openRequests = new Map<number, { resolve(): void; reject(error: Error): void }>()
/** One host restart request, settled by the extension's answer or by the page being replaced. */
const restartRequests = new Map<number, { resolve(): void; reject(error: Error): void }>()
/**
 * One deployment-model save request, settled by the extension's answer.
 *
 * The request carries the model id only: the extension host owns
 * `dsh.llmModel`, so the key and the profile never travel through this frame.
 */
const providerModelRequests = new Map<number, { resolve(): void; reject(error: Error): void }>()
/** One native selection request the extension host answers with a path or a refusal. */
type PickAnswer = { readonly path?: string; readonly reason?: 'cancelled' | 'unsupported' | 'failed'; readonly detail?: string }
const pickRequests = new Map<number, (answer: PickAnswer) => void>()

/**
 * Why a call could not run: the page's Host transport already closed.
 *
 * A closed transport never delivers an answer, so every public operation fails
 * with this error instead of registering a promise the Host can no longer
 * settle. {@link TransportClosedError.reason} names what closed it.
 */
export class TransportClosedError extends Error {
  /** Stable discriminator for callers that report transport teardown. */
  readonly code = 'transport/closed'

  /** @param reason - what ended the transport. */
  constructor(readonly reason: string) {
    super(`dsh webview: the Host transport is closed: ${reason}`)
    this.name = 'TransportClosedError'
  }
}

/**
 * @returns the reason the page's transport closed, or undefined while it is open.
 */
function transportClosedReason(): string | undefined {
  return transport?.closedReason
}

/**
 * Refuse work when the page can no longer reach the Host.
 * @throws TransportClosedError naming what closed the transport.
 */
function ensureHostOpen(): void {
  const reason = transportClosedReason()
  if (reason !== undefined) throw new TransportClosedError(reason)
}

/**
 * Settle every Host request this page owns outside the transport.
 *
 * The page's open, restart, model-save, and selection requests are not part of
 * the transport's own pending maps, so a reset that only settles fetches would
 * leave them waiting for an extension host that already answered or exited. A
 * deliberate stop is the extension's own restart, so a restart request resolves
 * instead of reporting a failure the page cannot act on; every other request
 * reports the closure.
 * @param reason - what ended the Host transport.
 * @param deliberate - whether the extension stopped the Host on purpose.
 */
function settlePageRequests(reason: string, deliberate = false): void {
  const closed = new TransportClosedError(reason)
  for (const pending of openRequests.values()) pending.reject(closed)
  openRequests.clear()
  for (const pending of restartRequests.values()) {
    if (deliberate) pending.resolve()
    else pending.reject(closed)
  }
  restartRequests.clear()
  for (const pending of providerModelRequests.values()) pending.reject(closed)
  providerModelRequests.clear()
  for (const resolve of pickRequests.values()) resolve({ reason: 'failed', detail: reason })
  pickRequests.clear()
}

/**
 * Ask the extension host to open one resource or external URL.
 * @param frame - request kind and its payload.
 * @returns settles when the host reported the outcome.
 * @throws TransportClosedError when the Host transport already ended.
 */
function requestHostOpen(
  frame:
    | { type: 'open-resource'; request: HostOpenRequest }
    | { type: 'open-external'; url: string }
    | { type: 'open-diff'; request: { title: string; before: string; after: string } },
): Promise<void> {
  ensureHostOpen()
  const id = nextId++
  return new Promise<void>((resolve, reject) => {
    openRequests.set(id, {
      resolve,
      reject: error => { reject(error) },
    })
    try {
      api.postMessage({ ...frame, id })
    } catch (error) {
      // A disposed Webview cannot deliver the request, so it must reject
      // instead of leaving the page waiting for an answer.
      openRequests.delete(id)
      reject(new TransportClosedError(`the request could not be sent: ${String(error)}`))
    }
  })
}

/**
 * Ask the extension host to restart DSH. A successful restart replaces this page, so the answer
 * arrives only when the request was refused.
 * @returns settles when the extension answered, or rejects with what it reported.
 * @throws TransportClosedError when the Host transport already ended.
 */
function requestHostRestart(): Promise<void> {
  ensureHostOpen()
  const id = nextId++
  return new Promise<void>((resolve, reject) => {
    restartRequests.set(id, { resolve, reject: error => { reject(error) } })
    try {
      api.postMessage({ type: 'restart-host', id })
    } catch (error) {
      // A disposed Webview cannot deliver the request, so it must reject instead of leaving the page waiting.
      restartRequests.delete(id)
      reject(new TransportClosedError(`the restart request could not be sent: ${String(error)}`))
    }
  })
}

/**
 * Ask the extension host to save the deployment route's model id.
 *
 * The host writes global `dsh.llmModel`; the value takes effect after the
 * restart the settings-change notice offers, so this resolves once the value is
 * saved rather than once it is active.
 * @param model - the model id the listing returned and the user chose.
 * @returns settles when the extension reported the save, or rejects with what it reported.
 * @throws TransportClosedError when the Host transport already ended.
 */
function requestSetProviderModel(model: string): Promise<void> {
  ensureHostOpen()
  const id = nextId++
  return new Promise<void>((resolve, reject) => {
    providerModelRequests.set(id, { resolve, reject: error => { reject(error) } })
    try {
      api.postMessage({ type: 'set-provider-model', id, model })
    } catch (error) {
      // A disposed Webview cannot deliver the request, so it must reject
      // instead of leaving the page showing an unanswered save.
      providerModelRequests.delete(id)
      reject(new TransportClosedError(`the model request could not be sent: ${String(error)}`))
    }
  })
}

/**
 * Ask the extension host to open its archive-or-folder chooser for a prepared plugin bundle.
 * @param kind - one archive file, or one package directory.
 * @returns the selected local absolute path, or why no path was returned.
 * @throws TransportClosedError when the Host transport already ended.
 */
async function requestLocalBundlePath(kind: 'file' | 'folder'): Promise<PickAnswer> {
  ensureHostOpen()
  const id = nextId++
  const answer = new Promise<PickAnswer>((resolve) => { pickRequests.set(id, resolve) })
  try {
    api.postMessage({ type: 'pick-local-path', id, kind })
  } catch (error) {
    pickRequests.delete(id)
    throw new TransportClosedError(`the selection request could not be sent: ${String(error)}`)
  }
  return await answer
}

/**
 * Resolve a Host bundle URL to the materialized webview resource.
 * @param url - the exact URL the Host's module graph published.
 * @returns a URL the webview can load, or the input when the Host has not mapped it.
 */
function resolveUrl(url: string): string {
  return assets[url] ?? url
}

/** References that name a package asset, which has no HTTP route in this carrier. */
const PACKAGE_ASSET_REFERENCE = /^plugins\/(?:@[^/]+\/[^/]+|[^@/][^/]*)\/assets\//u

/**
 * Resolve one `require.asset` reference.
 *
 * The mapping is prepared before the requesting code runs. A package asset the
 * Host did not prepare means the package was withheld, so this fails with the
 * reference instead of returning it: a literal reference would make plugin code
 * render or fetch against a path this carrier does not serve.
 * @param reference - the reference the bundle passed.
 * @returns the materialized URL, or the reference when it is not a package asset.
 * @throws Error naming the reference when no package asset was prepared for it.
 */
export function resolveAsset(reference: string): string {
  const mapped = assets[reference]
  if (mapped !== undefined) return mapped
  if (!PACKAGE_ASSET_REFERENCE.test(reference)) return reference
  throw new Error(`dsh webview: the package asset was not prepared: ${reference}`)
}

/**
 * Append and await one external script.
 * @param src - absolute script URL.
 * @param module - load as an ES module.
 * @returns resolves after the script executed.
 */
function loadScript(src: string, module = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    if (module) el.type = 'module'
    el.nonce = nonce
    el.src = src
    el.onload = () => { resolve() }
    el.onerror = () => { reject(new Error(`dsh webview: failed to load ${src}`)) }
    document.head.append(el)
  })
}

/**
 * Execute one boot injection table in order.
 * @param rows - injection rows from the Host.
 */
async function applyInjections(rows: readonly InjectionRow[]): Promise<void> {
  for (const row of rows) {
    switch (row.kind) {
      case 'global':
        globals[row.name] = row.value
        break
      case 'script': {
        const el = document.createElement('script')
        el.nonce = nonce
        el.textContent = row.text
        document.head.append(el)
        break
      }
      case 'script-src':
        await loadScript(resolveUrl(row.src))
        break
      case 'script-preload':
        break
      case 'style': {
        const el = document.createElement('style')
        el.nonce = nonce
        el.textContent = row.text
        document.head.append(el)
        break
      }
      case 'html':
        document.head.insertAdjacentHTML('beforeend', row.html)
        break
    }
  }
}

/** One Webview request the Host answers later. */
interface PendingFetch {
  resolve(answer: FetchAnswer): void
  reject(error: unknown): void
  abort(): void
}

/** One streamed upload in flight. */
interface PendingUpload {
  /** Whether the Host answered or the caller cancelled; the pump stops sending after this. */
  settled: boolean
  resolve(response: Response): void
  reject(error: unknown): void
  abort(): void
}

/** Host frames one logical stream consumes. */
type StreamFrame = Extract<HostFrame, { type: 'stream-item' | 'stream-end' | 'stream-uplink-ack' }>

/** Origin relative Host routes resolve against; it never reaches the Host. */
const HOST_ORIGIN = 'http://dsh.local'

/** Media types that carry bytes rather than text, so the unary route cannot represent them. */
const BINARY_MEDIA_TYPE = /^(?:multipart\/|image\/|audio\/|video\/|application\/(?:octet-stream|pdf|zip|gzip|x-gzip|x-tar|wasm)\b)/u

/**
 * @returns a fresh AbortError for caller cancellation and transport teardown.
 */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Normalize one call with the standard Fetch rules.
 *
 * A `Request` input supplies its URL, method, headers, body, and signal, and
 * `init` overrides them exactly as `new Request(input, init)` does; using the
 * constructor keeps one implementation of that rule for both the unary route
 * and the upload carrier. A relative route resolves against a fixed Host origin
 * instead of the Webview origin, because the Host mounts its handler at the
 * root path.
 * @param input - request or route.
 * @param init - overrides applied over the input's own fields.
 * @returns the normalized request with its body unread.
 * @throws TypeError when the combination is invalid, such as GET with a body.
 */
function normalizeRequest(input: RequestInfo | URL, init: RequestInit | undefined): Request {
  // A streamed body needs the Node Request constructor's duplex flag. The upload
  // carrier always streams that body, and a browser accepts the same field.
  const streaming: RequestInit & { duplex: 'half' } = { ...init, duplex: 'half' }
  const normalized = init?.body instanceof ReadableStream ? streaming : init
  // A Request input is handed to the constructor itself so it keeps its method,
  // headers, body, and signal; only a route string or URL is resolved against
  // the Host origin.
  return input instanceof Request
    ? new Request(input, normalized)
    : new Request(new URL(input instanceof URL ? input.href : input, HOST_ORIGIN), normalized)
}

/**
 * @param request - normalized request.
 * @returns the root-relative route the Host serves, with its query.
 */
function hostRoute(request: Request): string {
  const url = new URL(request.url)
  return `${url.pathname}${url.search}`
}

/**
 * @param bytes - binary chunk.
 * @returns base64 text safe for the Webview message channel.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/**
 * The browser half of the Host transport: unary requests, logical streams, the
 * acknowledged upload carrier, and lazy asset preparation.
 *
 * One instance serves the page. {@link WebviewTransport.dispose} settles every
 * request it owns, so a companion that exited or a page that went away cannot
 * leave a fetch, upload, asset request, or uplink acknowledgement waiting. The
 * transport stays closed afterwards: a later call fails with
 * {@link TransportClosedError} instead of registering a request whose answer
 * cannot arrive.
 */
export class WebviewTransport {
  private nextId = 1
  private readonly fetches = new Map<number, PendingFetch>()
  private readonly streams = new Map<number, (frame: StreamFrame) => void>()
  private readonly streamAcks = new Map<string, () => void>()
  private readonly uploads = new Map<number, PendingUpload>()
  private readonly uploadAcks = new Map<string, () => void>()
  private readonly assetRequests = new Map<number, { resolve(uri: string): void; reject(error: unknown): void }>()
  /** Body readers this transport is draining, cancelled by {@link dispose}. */
  private readonly bodyStops = new Set<() => void>()
  private disposed: string | undefined

  /**
   * @param post - delivers one frame to the extension.
   * @param mergeAssets - merges prepared asset references into the page's boot map.
   * @param resolveUrl - resolves one boot graph URL through that map.
   * @param hasAsset - whether the boot map already names one URL.
   * @param limits - bounded-transfer budgets this page enforces.
   */
  constructor(
    private readonly post: (message: unknown) => void,
    private readonly mergeAssets: (assets: Readonly<Record<string, string>>) => void,
    private readonly resolveUrl: (url: string) => string,
    private readonly hasAsset: (url: string) => boolean,
    private readonly limits: BridgeLimits = DEFAULT_BRIDGE_LIMITS,
  ) {}

  /** @returns why this transport closed, or undefined while it is open. */
  get closedReason(): string | undefined {
    return this.disposed
  }

  /**
   * @returns how many requests, body reads, and acknowledgements this transport
   * still waits for; teardown leaves zero, which is what proves a closed page
   * holds nothing.
   */
  get pendingCount(): number {
    return this.fetches.size
      + this.uploads.size
      + this.assetRequests.size
      + this.streamAcks.size
      + this.uploadAcks.size
      + this.bodyStops.size
  }

  /**
   * Unary call over the Host bridge, shaped as a Fetch response for Connection.
   * @param input - request or route.
   * @param init - request init; a Request input supplies any field it omits.
   * @returns the Host's response.
   * @throws TransportClosedError when the Host transport already ended.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const answer = await this.requestFetch(input, init, false)
    if (!('body' in answer)) throw new Error('dsh webview: the host answered a text request without text')
    return new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  /**
   * Ask the Host for one route's response bytes.
   * @param url - root-relative Host route, with its query.
   * @param signal - cancellation; the Host aborts the same request.
   * @returns status, base64 bytes, and the served media type.
   */
  async binaryFetch(url: string, signal: AbortSignal): Promise<BinaryAnswer> {
    const answer = await this.requestFetch(url, { method: 'GET', signal }, true)
    if (!('base64' in answer)) throw new Error('dsh webview: the host answered a binary request without bytes')
    return answer
  }

  /**
   * Stream one browser body to the Host through acknowledged chunks.
   * @param input - target route, or a Request whose body is the upload body.
   * @param init - method, headers, body, and cancellation.
   * @returns the Host upload response.
   * @throws TransportClosedError when the Host transport already ended.
   */
  async upload(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.ensureOpen()
    const request = normalizeRequest(input, init)
    const signal = request.signal
    if (signal.aborted) throw abortError()
    const body = request.body
    if (body === null) throw new Error('dsh webview: upload body is missing')
    const id = this.nextId++
    const answer = new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.uploads.get(id)
        if (pending !== undefined) pending.settled = true
        this.uploads.delete(id)
        this.releaseUploadAcks(id)
        this.sendIfOpen({ type: 'upload-cancel', id })
        reject(abortError())
      }
      signal.addEventListener('abort', abort, { once: true })
      this.uploads.set(id, {
        settled: false,
        resolve: (response) => {
          signal.removeEventListener('abort', abort)
          resolve(response)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
        abort,
      })
    })
    try {
      this.postFrame({
        type: 'upload-open',
        id,
        url: hostRoute(request),
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
      })
    } catch (error) {
      // A failed opening frame leaves this upload with no Host reader, so the
      // page settles it and refuses later work on the closed transport.
      this.dispose(describe(error))
      await answer.catch(() => {})
      throw error
    }
    void this.pumpUpload(id, body, signal)
    return await answer
  }

  /**
   * Open one logical Host stream over the bridge.
   * @param endpoint - gateway endpoint name.
   * @param requestPayload - request payload.
   * @param signal - caller cancellation.
   * @param uplink - client uplink items (`session/follow` uses them).
   * @returns decoded stream values.
   * @throws TransportClosedError when the Host transport already ended.
   */
  openStream(
    endpoint: string,
    requestPayload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncIterable<unknown> {
    const live = this
    return {
      async *[Symbol.asyncIterator]() {
        live.ensureOpen()
        const id = live.nextId++
        const queue: unknown[] = []
        let ended = false
        let failure: { code: string; message: string } | undefined
        let wake: (() => void) | undefined
        const ping = (): void => { const current = wake; wake = undefined; current?.() }
        live.streams.set(id, (frame) => {
          if (frame.type === 'stream-item') queue.push(frame.item)
          if (frame.type === 'stream-end') {
            ended = true
            failure = frame.error
            live.releaseAcks(id)
          }
          if (frame.type === 'stream-uplink-ack') live.streamAcks.get(`${id}:${frame.seq}`)?.()
          ping()
        })
        const cancel = (): void => {
          live.sendIfOpen({ type: 'stream-cancel', id })
          live.releaseAcks(id)
          ping()
        }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          live.postFrame({
            type: 'stream-open',
            id,
            endpoint,
            payload: requestPayload,
            // The uplink is a live async iterable owned by the caller; the bridge
            // forwards items as they arrive.
            ...uplink === undefined ? {} : { uplink: true },
          })
        } catch (error) {
          live.streams.delete(id)
          signal.removeEventListener('abort', cancel)
          live.releaseAcks(id)
          throw error
        }
        let uplinkPump: Promise<void> | undefined
        if (uplink !== undefined) {
          uplinkPump = (async () => {
            let seq = 0
            for await (const item of uplink) {
              if (signal.aborted || ended) return
              seq++
              const accepted = new Promise<void>((resolve) => {
                live.streamAcks.set(`${id}:${seq}`, resolve)
              })
              live.sendIfOpen({ type: 'stream-item-send', id, seq, item })
              await accepted
            }
            if (!signal.aborted && !ended) {
              seq++
              const accepted = new Promise<void>((resolve) => {
                live.streamAcks.set(`${id}:${seq}`, resolve)
              })
              live.sendIfOpen({ type: 'stream-end-send', id, seq })
              await accepted
            }
          })().catch(() => {})
        }
        try {
          while (true) {
            if (queue.length > 0) { yield queue.shift(); continue }
            if (failure !== undefined) throw new Error(failure.message)
            if (ended) return
            if (signal.aborted) throw abortError()
            live.ensureOpen()
            await new Promise<void>((resolve) => { wake = resolve })
          }
        } finally {
          ping()
          live.streams.delete(id)
          signal.removeEventListener('abort', cancel)
          if (!signal.aborted) cancel()
          await uplinkPump
          live.releaseAcks(id)
        }
      },
    }
  }

  /**
   * Append and await one bundle script, preparing its package's assets first.
   *
   * `require.asset` resolves synchronously, so the module's assets must be in
   * the map before its factory runs; a package whose assets could not be
   * prepared fails here instead of executing against missing URLs.
   * @param url - the exact bundle URL the Host's module graph published.
   * @throws TransportClosedError when the Host transport already ended.
   */
  async loadBundle(url: string): Promise<void> {
    this.ensureOpen()
    const mapped = this.resolveUrl(url)
    if (mapped !== url || this.hasAsset(url)) {
      await loadScript(mapped)
      return
    }
    const materialized = await this.requestAsset(url)
    this.ensureOpen()
    await loadScript(materialized)
  }

  /**
   * Handle one frame owned by the transport.
   * @param frame - decoded host frame.
   * @returns whether the frame belonged to the transport.
   */
  handleFrame(frame: HostFrame): boolean {
    switch (frame.type) {
      case 'fetch-result': {
        const pending = this.fetches.get(frame.id)
        this.fetches.delete(frame.id)
        pending?.resolve('base64' in frame
          ? { status: frame.status, base64: frame.base64, contentType: frame.contentType }
          : { status: frame.status, body: frame.body })
        return true
      }
      case 'upload-result': {
        const pending = this.uploads.get(frame.id)
        if (pending !== undefined) pending.settled = true
        this.uploads.delete(frame.id)
        this.releaseUploadAcks(frame.id)
        pending?.resolve(new Response(frame.body, { status: frame.status }))
        return true
      }
      case 'upload-ack': {
        const accepted = this.uploadAcks.get(`${frame.id}:${frame.seq}`)
        this.uploadAcks.delete(`${frame.id}:${frame.seq}`)
        accepted?.()
        return true
      }
      case 'stream-item':
      case 'stream-end':
      case 'stream-uplink-ack':
        this.streams.get(frame.id)?.(frame)
        return true
      case 'asset-result': {
        if (frame.assets !== undefined) this.mergeAssets(frame.assets)
        const pending = this.assetRequests.get(frame.id)
        this.assetRequests.delete(frame.id)
        if (frame.error !== undefined) pending?.reject(new Error(frame.error))
        else if (frame.uri === undefined) pending?.reject(new Error('dsh webview: the Host named no URI for the asset'))
        else pending?.resolve(frame.uri)
        return true
      }
      case 'transport-reset':
        this.dispose(frame.reason)
        return true
      default:
        return false
    }
  }

  /**
   * Settle everything this transport owns.
   * @param reason - why the transport ended.
   */
  /**
   * Settle everything this transport owns, and refuse every later call.
   *
   * A closed transport has no Host that can answer, so an in-flight fetch,
   * upload, asset request, stream, or body read is cancelled here rather than
   * left waiting for a frame that will never arrive.
   * @param reason - why the transport ended.
   */
  dispose(reason: string): void {
    if (this.disposed !== undefined) return
    this.disposed = reason
    // Body reads are cancelled first: their owner is awaiting a reader, not a
    // frame, so clearing the pending maps alone would leave them reading.
    for (const stop of [...this.bodyStops]) stop()
    this.bodyStops.clear()
    for (const pending of this.fetches.values()) pending.abort()
    this.fetches.clear()
    for (const pending of this.uploads.values()) pending.abort()
    this.uploads.clear()
    this.releaseAllAcks()
    for (const [id, receive] of this.streams) {
      receive({ type: 'stream-end', id, error: { code: 'transport/reset', message: reason } })
    }
    this.streams.clear()
    for (const pending of this.assetRequests.values()) pending.reject(new TransportClosedError(reason))
    this.assetRequests.clear()
  }

  /**
   * Refuse a call the Host can no longer answer.
   * @throws TransportClosedError naming what closed the transport.
   */
  private ensureOpen(): void {
    if (this.disposed !== undefined) throw new TransportClosedError(this.disposed)
  }

  /**
   * Post one frame, failing the call when the page cannot reach the Host.
   *
   * A rejected `postMessage` means the page is going away: the transport is
   * kept open here so the caller can remove its own pending entry first and
   * then close the transport for every other waiter.
   * @param message - JSON-serializable frame.
   * @throws TransportClosedError when the transport already ended or the frame
   * could not be posted.
   */
  private postFrame(message: object): void {
    this.ensureOpen()
    try {
      this.post(message)
    } catch (error) {
      throw new TransportClosedError(`a frame could not be posted: ${describe(error)}`)
    }
  }

  /**
   * Send one frame that is only useful while the Host is live.
   *
   * Cancellations and acknowledgements are best effort: a closed transport has
   * nobody to notify, and their failure must not replace the caller's outcome.
   * @param message - JSON-serializable frame.
   */
  private sendIfOpen(message: object): void {
    if (this.disposed !== undefined) return
    try {
      this.post(message)
    } catch {
      // The Webview is gone, so this frame has no reader left.
    }
  }

  /**
   * Send one unary request and await the Host's answer.
   * @param input - request or route.
   * @param init - overrides.
   * @param binary - whether the Host should answer with bytes instead of text.
   * @returns the Host's answer.
   * @throws TransportClosedError when the Host transport already ended.
   */
  private async requestFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    binary: boolean,
  ): Promise<FetchAnswer> {
    this.ensureOpen()
    const request = normalizeRequest(input, init)
    const signal = request.signal
    // The signal is checked before the body is read and again before the first
    // frame: an already cancelled request sends nothing at all.
    if (signal.aborted) throw abortError()
    const body = await this.readTextBody(request)
    this.ensureOpen()
    if (signal.aborted) throw abortError()
    const id = this.nextId++
    const answer = new Promise<FetchAnswer>((resolve, reject) => {
      const abort = (): void => {
        this.fetches.delete(id)
        this.sendIfOpen({ type: 'fetch-cancel', id })
        reject(abortError())
      }
      signal.addEventListener('abort', abort, { once: true })
      this.fetches.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
        abort,
      })
    })
    try {
      this.postFrame({
        type: 'fetch',
        id,
        url: hostRoute(request),
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        ...body === undefined ? {} : { body },
        ...binary ? { binary: true } : {},
      })
    } catch (error) {
      // The frame never reached the Host, so this request cannot be answered.
      this.dispose(describe(error))
      await answer.catch(() => {})
      throw error
    }
    return await answer
  }

  /**
   * Read the text a unary request carries, bounded and cancellable.
   *
   * A unary answer cannot express bytes, so the body's representation is stated
   * rather than inferred: it must be text with a content type, and a binary
   * media type is refused. Binary, streaming, and multipart bodies belong to the
   * upload carrier, which is the only path that preserves their bytes.
   *
   * The reader is owned here rather than delegated to `Request.text()` so an
   * abort or a transport reset cancels the body itself; otherwise the read would
   * continue after the caller stopped waiting. The decoder keeps multi-byte
   * sequences that cross a chunk boundary intact.
   * @param request - normalized request.
   * @returns the text body, or undefined when the request has none.
   * @throws TransportClosedError when the transport ended during the read.
   */
  private async readTextBody(request: Request): Promise<string | undefined> {
    if (request.body === null) return undefined
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType === '' || BINARY_MEDIA_TYPE.test(contentType)) {
      throw new Error(
        'dsh webview: a unary request body must be text with a content type; '
        + 'use the file-upload carrier for binary or streaming data',
      )
    }
    const signal = request.signal
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    const limit = this.limits.unaryBodyBytes
    let text = ''
    let bytes = 0
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      // A stream that already ended or errored refuses the cancel; the read
      // outcome below reports the same end.
      void reader.cancel().catch(() => {})
    }
    const onAbort = (): void => { stop() }
    signal.addEventListener('abort', onAbort, { once: true })
    this.bodyStops.add(stop)
    if (this.disposed !== undefined) stop()
    try {
      while (true) {
        if (this.disposed !== undefined) throw new TransportClosedError(this.disposed)
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > limit) {
          stop()
          throw new RangeError(
            `dsh webview: the request body exceeds the ${String(limit)}-byte unary limit; `
            + 'use the file-upload carrier for larger or streamed data',
          )
        }
        text += decoder.decode(result.value, { stream: true })
        if (signal.aborted) throw abortError()
      }
      // A cancelled reader ends its pending read as "done"; returning the text
      // collected so far would report a truncated body as a complete one.
      if (stopped) {
        if (this.disposed !== undefined) throw new TransportClosedError(this.disposed)
        throw abortError()
      }
      return text + decoder.decode()
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.bodyStops.delete(stop)
      try {
        if (stopped) stop()
        reader.releaseLock()
      } catch {
        // A reader with a pending cancel cannot be released, and its owner is
        // already failing this request.
      }
    }
  }

  /**
   * Read one upload body and send it as acknowledged chunks.
   *
   * Chunks carry one at a time: the next is read and sent only after the Host
   * acknowledged the previous one, and the pump stops as soon as the Host
   * answered or the caller cancelled, so a settled upload never keeps reading.
   * @param id - upload request id.
   * @param body - normalized request body.
   * @param signal - the request's effective cancellation.
   */
  private async pumpUpload(id: number, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader()
    let consumed = false
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      // A body whose producer is still waiting refuses the cancel; the read outcome reports the same end.
      void reader.cancel().catch(() => {})
    }
    const onAbort = (): void => { stop() }
    signal.addEventListener('abort', onAbort, { once: true })
    // A closed transport or a cancelled request must release a reader that is waiting on the body, not
    // only stop the next send.
    this.bodyStops.add(stop)
    let seq = 0
    const finished = (): boolean => this.disposed !== undefined || this.uploads.get(id)?.settled !== false
    try {
      while (!finished() && !signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) { consumed = true; break }
        if (finished() || signal.aborted) break
        seq++
        const accepted = new Promise<void>((resolve) => { this.uploadAcks.set(`${id}:${seq}`, resolve) })
        this.sendIfOpen({ type: 'upload-chunk', id, seq, data: bytesToBase64(chunk.value) })
        await accepted
      }
      if (!finished() && !signal.aborted) {
        seq++
        const accepted = new Promise<void>((resolve) => { this.uploadAcks.set(`${id}:${seq}`, resolve) })
        this.sendIfOpen({ type: 'upload-end', id, seq })
        await accepted
      }
    } catch (error) {
      const pending = this.uploads.get(id)
      if (pending !== undefined) pending.settled = true
      pending?.reject(error)
      this.releaseUploadAcks(id)
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.bodyStops.delete(stop)
      if (!consumed) stop()
      try {
        reader.releaseLock()
      } catch {
        // The reader has a pending cancel; its owner already settled this upload.
      }
    }
  }

  /**
   * Ask the Host to materialize one bundle the boot payload did not include,
   * together with the assets of the package that owns it.
   * @param url - the exact bundle URL.
   * @returns the webview URI.
   * @throws when the Host could not serve the bundle or its package's assets,
   * or when the transport ended first.
   */
  private async requestAsset(url: string): Promise<string> {
    this.ensureOpen()
    const id = this.nextId++
    const answer = new Promise<string>((resolve, reject) => { this.assetRequests.set(id, { resolve, reject }) })
    try {
      this.postFrame({ type: 'asset', id, url })
    } catch (error) {
      this.assetRequests.delete(id)
      this.dispose(describe(error))
      await answer.catch(() => {})
      throw error
    }
    return await answer
  }

  /**
   * Wake every upload chunk waiting for a Host acknowledgement.
   * @param id - upload request id.
   */
  private releaseUploadAcks(id: number): void {
    for (const [key, resolve] of this.uploadAcks) {
      if (!key.startsWith(`${id}:`)) continue
      this.uploadAcks.delete(key)
      resolve()
    }
  }

  /**
   * Wake every uplink send waiting for an acknowledgement from one stream.
   * @param id - logical stream id.
   */
  private releaseAcks(id: number): void {
    for (const [key, resolve] of this.streamAcks) {
      if (!key.startsWith(`${id}:`)) continue
      this.streamAcks.delete(key)
      resolve()
    }
  }

  /** Wake every acknowledgement waiter left by a closed transport. */
  private releaseAllAcks(): void {
    for (const resolve of this.streamAcks.values()) resolve()
    this.streamAcks.clear()
    for (const resolve of this.uploadAcks.values()) resolve()
    this.uploadAcks.clear()
  }
}

/** Install the transport globals the DSH client reads, over the live transport instance. */
function installTransport(): void {
  const live = transport
  if (live === undefined) throw new Error('dsh webview: the transport is not installed')
  globals.__DSH_TRANSPORT__ = {
    ownsHost: true,
    managesExtensions: true,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => live.fetch(input, init),
    openStream: (
      endpoint: string,
      payload: unknown,
      signal: AbortSignal,
      uplink?: AsyncIterable<unknown>,
    ) => live.openStream(endpoint, payload, signal, uplink),
    loadBundle: (url: string) => live.loadBundle(url),
    resolveAsset: (reference: string) => resolveAsset(reference),
    openResource: (request: HostOpenRequest) => requestHostOpen({ type: 'open-resource', request }),
    openExternal: (url: string) => requestHostOpen({ type: 'open-external', url }),
    openDiff: (request: { title: string; before: string; after: string }) => requestHostOpen({ type: 'open-diff', request }),
    restartHost: () => requestHostRestart(),
    setProviderModel: (model: string) => requestSetProviderModel(model),
    pickLocalBundlePath: (kind: 'file' | 'folder') => requestLocalBundlePath(kind),
    readInstallReceipt: () => {
      const state = api.getState()
      return typeof state === 'object' && state !== null && 'installReceipt' in state ? state.installReceipt : undefined
    },
    writeInstallReceipt: (receipt: string | null) => {
      const previous = api.getState()
      const state = typeof previous === 'object' && previous !== null ? { ...previous } : {}
      api.setState({ ...state, installReceipt: receipt })
    },
  }
  // Host HTTP routes such as the changed-files summary use the page's global
  // fetch. The VS Code webview cannot reach those routes directly, so send
  // same-origin /api requests over the host transport instead.
  const transportFetch = (input: RequestInfo | URL, init?: RequestInit) => live.fetch(input, init)
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    try {
      if (new URL(url, globalThis.location.href).pathname.startsWith('/api/')) {
        return transportFetch(input, init)
      }
    } catch {
      // A non-URL request keeps the native fetch; the transport would reject it anyway.
    }
    return nativeFetch(input, init)
  }
  globals.__DSH_FILE_UPLOAD__ = {
    fetch: (input: string | URL, init: RequestInit) => live.upload(input, init),
  }
}

/** Host routes that answer with image bytes the Webview cannot load as a plain URL. */
const DETAIL_IMAGE_PATHS: readonly string[] = [
  '/api/plugin-manager/detail-file',
  '/api/plugin-market/detail-file',
]

/** Largest detail image accepted through the binary bridge, in bytes; the Host route serves at most 5 MiB. */
export const MAX_DETAIL_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Match one image source to a Host route that serves images beside a detail document.
 * @param src - the image source, as the page wrote it.
 * @param baseUri - the document's base URI, which a relative source resolves against.
 * @returns the root-relative route with its query, or undefined for every other source.
 */
export function detailImageRoute(src: string, baseUri: string): string | undefined {
  let url: URL
  try {
    url = new URL(src, baseUri)
  } catch {
    return undefined
  }
  if (!DETAIL_IMAGE_PATHS.includes(url.pathname)) return undefined
  return `${url.pathname}${url.search}`
}

/**
 * Decode the bytes of one binary Host answer.
 * @param text - base64 text from the Host.
 * @returns the decoded bytes.
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** One detail image this bootstrap is resolving. */
interface DetailImage {
  /** The authored `src` the bytes are fetched for. */
  readonly source: string
  /** Cancels the fetch when the element changes or goes away. */
  readonly controller: AbortController
  /** The Blob URL to show, once the bytes arrived. */
  blobUrl?: string
}

/** Detail images resolved in this document, kept so each Blob URL can be revoked. */
const detailImages = new Map<HTMLImageElement, DetailImage>()

/**
 * @param contentType - the media type the Host served.
 * @returns the bare type when it is an image, otherwise undefined.
 */
function imageMediaType(contentType: string): string | undefined {
  const [type] = contentType.split(';')
  const bare = type?.trim().toLowerCase()
  return bare !== undefined && bare.startsWith('image/') ? bare : undefined
}

/**
 * Fetch one detail image through the binary bridge and show its Blob URL.
 * @param image - element to resolve.
 * @param state - the request this element owns.
 * @param route - the matched Host route.
 */
function loadDetailImage(image: HTMLImageElement, state: DetailImage, route: string): void {
  void (async () => {
    try {
      const live = transport
      if (live === undefined) throw new Error('dsh webview: the transport is not installed')
      const answer = await live.binaryFetch(route, state.controller.signal)
      const mediaType = imageMediaType(answer.contentType)
      if (answer.status !== 200 || mediaType === undefined) {
        throw new Error(`the Host answered HTTP ${String(answer.status)} ${answer.contentType}`)
      }
      const bytes = decodeBase64(answer.base64)
      if (bytes.byteLength > MAX_DETAIL_IMAGE_BYTES) {
        throw new Error(`the image exceeds the ${String(MAX_DETAIL_IMAGE_BYTES)}-byte limit`)
      }
      if (detailImages.get(image) !== state || state.controller.signal.aborted) return
      state.blobUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
      image.src = state.blobUrl
    } catch (error) {
      // A failure leaves the authored source, so the page's own fallback still applies.
      if (!state.controller.signal.aborted) {
        api.postMessage({ type: 'log', line: `webview: detail image failed for ${route}: ${describe(error)}` })
      }
    }
  })()
}

/**
 * Abort and revoke one element's detail image.
 * @param image - element whose resolution ends.
 */
function releaseDetailImage(image: HTMLImageElement): void {
  const state = detailImages.get(image)
  if (state === undefined) return
  detailImages.delete(image)
  state.controller.abort()
  if (state.blobUrl !== undefined) URL.revokeObjectURL(state.blobUrl)
}

/**
 * Start, keep, or release the resolution of one image element's current `src`.
 * @param image - the element to inspect.
 */
function considerDetailImage(image: HTMLImageElement): void {
  const source = image.getAttribute('src')
  if (source === null) {
    releaseDetailImage(image)
    return
  }
  const state = detailImages.get(image)
  if (state !== undefined) {
    // This resolver wrote the attribute; the Blob URL is still current.
    if (source === state.blobUrl) return
    // The page reasserted the authored source, so the same bytes stay usable.
    if (source === state.source) {
      if (state.blobUrl !== undefined) image.src = state.blobUrl
      return
    }
    releaseDetailImage(image)
  }
  const route = detailImageRoute(source, document.baseURI)
  if (route === undefined) return
  const next: DetailImage = { source, controller: new AbortController() }
  detailImages.set(image, next)
  loadDetailImage(image, next, route)
}

/**
 * Run one visitor over an element and the images below it.
 * @param node - added or removed node.
 * @param visit - receives every image in the subtree.
 */
function forEachImage(node: Node, visit: (image: HTMLImageElement) => void): void {
  if (node instanceof HTMLImageElement) {
    visit(node)
    return
  }
  if (!(node instanceof Element)) return
  for (const image of node.querySelectorAll('img')) visit(image)
}

/** Resolve plugin detail images to Blob URLs, and revoke each URL when its element changes or leaves the page. */
function installDetailImages(): void {
  if (typeof MutationObserver !== 'function' || typeof URL.createObjectURL !== 'function') return
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.target instanceof HTMLImageElement) considerDetailImage(mutation.target)
        continue
      }
      // A node moved between parents is disconnected while the callback is
      // queued, so only images that stayed out of the document are released.
      for (const node of mutation.removedNodes) forEachImage(node, image => { if (!image.isConnected) releaseDetailImage(image) })
      for (const node of mutation.addedNodes) forEachImage(node, considerDetailImage)
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['src'],
    childList: true,
    subtree: true,
  })
  window.addEventListener('pagehide', () => {
    observer.disconnect()
    for (const image of [...detailImages.keys()]) releaseDetailImage(image)
  }, { once: true })
}

/** Forward non-routine Webview diagnostics to the extension output channel. */
function installConsoleForwarding(): void {
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...values: unknown[]): void => {
      original(...values)
      api.postMessage({
        type: 'log',
        line: `webview ${level}: ${values.map(consoleValue).join(' ')}`,
      })
    }
  }
}

/**
 * @param value - one console argument.
 * @returns a bounded readable diagnostic value.
 */
function consoleValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Apply one frame the host posted.
 * @param frame - decoded host frame.
 */
function handleHostFrame(frame: HostFrame): void {
  // A reset settles the transport's own waits and the page requests this
  // bootstrap owns, so a restart or a companion exit never leaves a caller
  // waiting for an answer the extension will not send.
  if (frame.type === 'transport-reset') {
    transport?.dispose(frame.reason)
    settlePageRequests(frame.reason, frame.deliberate === true)
    return
  }
  if (transport?.handleFrame(frame) === true) return
  switch (frame.type) {
    case 'open-result': {
      const pending = openRequests.get(frame.id)
      openRequests.delete(frame.id)
      if (frame.ok) pending?.resolve()
      else pending?.reject(new Error(frame.error ?? 'the host could not open it'))
      return
    }
    case 'restart-result': {
      const pending = restartRequests.get(frame.id)
      restartRequests.delete(frame.id)
      if (frame.ok) pending?.resolve()
      else pending?.reject(new Error(frame.error ?? 'the host did not restart'))
      return
    }
    case 'set-provider-model-result': {
      const pending = providerModelRequests.get(frame.id)
      providerModelRequests.delete(frame.id)
      if (frame.ok) pending?.resolve()
      else pending?.reject(new Error(frame.error ?? 'the host did not save the model'))
      return
    }
    case 'pick-result':
      pickRequests.get(frame.id)?.({
        ...frame.path === undefined ? {} : { path: frame.path },
        ...frame.reason === undefined ? {} : { reason: frame.reason },
        ...frame.detail === undefined ? {} : { detail: frame.detail },
      })
      pickRequests.delete(frame.id)
      return
    case 'dsh-command':
      dispatchDshCommand(frame.command)
      return
    case 'log':
      console.info(frame.line)
      return
    default:
      return
  }
}

/**
 * Deliver one extension-scoped shortcut to the DSH shell.
 *
 * The DSH client owns its shortcut registry in the page window. A VS Code
 * keybinding cannot run that registry directly, so the extension command
 * forwards the same chord as a synthetic key event; the shell's window
 * listener then runs the action with its normal modal and editable guards.
 * @param command - stable command id exposed by the extension.
 */
function dispatchDshCommand(command: 'session.new' | 'session.search' | 'session.fork'): void {
  const shortcut = command === 'session.new'
    ? { code: 'KeyN', key: 'n', alt: true, shift: false }
    : command === 'session.search'
      ? { code: 'KeyK', key: 'k', alt: true, shift: false }
      : { code: 'KeyF', key: 'f', alt: false, shift: true }
  // The shell is mounted directly in this frame; a composition that nests it
  // inside an iframe still resolves the same window.
  const target = document.querySelector('iframe')?.contentWindow ?? window
  const primary = /darwin|mac|iphone|ipad/iu.test(navigator.platform)
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: shortcut.key,
    code: shortcut.code,
    ctrlKey: !primary,
    metaKey: primary,
    altKey: shortcut.alt,
    shiftKey: shortcut.shift,
    bubbles: true,
    cancelable: true,
  }))
}

/** Read the host payload, install the transport, and load the shell. */
function start(): void {
  const payload = (globals as { __DSH_BOOT_PAYLOAD__?: BootPayload }).__DSH_BOOT_PAYLOAD__
  if (payload === undefined) throw new Error('dsh webview: the boot payload is missing')
  const acquire = (globals as { acquireVsCodeApi?: () => WebviewApi }).acquireVsCodeApi
  if (acquire === undefined) throw new Error('dsh webview: acquireVsCodeApi is unavailable')
  api = acquire()
  assets = payload.assets
  nonce = payload.nonce
  transport = new WebviewTransport(
    message => { api.postMessage(message) },
    merged => { assets = { ...assets, ...merged } },
    url => resolveUrl(url),
    url => assets[url] !== undefined,
    readBridgeLimits(payload.limits) ?? DEFAULT_BRIDGE_LIMITS,
  )

  window.addEventListener('message', (event: MessageEvent) => {
    handleHostFrame(event.data as HostFrame)
  })
  installConsoleForwarding()
  installTransport()
  installDetailImages()

  // A page that goes away owns no further Host work: settle every request it
  // started instead of leaving the companion serving a reader nobody holds.
  window.addEventListener('pagehide', () => {
    const reason = 'the Webview page was hidden'
    transport?.dispose(reason)
    settlePageRequests(reason)
  }, { once: true })

  // The shell reads `__DSH_BOOT__` and `__DSH_TRANSPORT__` when its module
  // evaluates, so every injection row must land first; the module script itself
  // is deferred by the document.
  window.addEventListener('error', (event) => {
    api.postMessage({ type: 'log', line: `webview error: ${String(event.message)}` })
  })
  void (async () => {
    await applyInjections(payload.injections)
    api.postMessage({ type: 'log', line: 'webview: injections applied' })
    await loadScript(payload.shell, true)
    api.postMessage({ type: 'log', line: 'webview: shell loaded' })
  })().catch((error: unknown) => {
    console.error(error)
    api.postMessage({ type: 'log', line: `webview boot failed: ${String(error)}` })
  })
}

// Importing this module outside the Webview, in a unit test or transport probe,
// must not require the Webview API, the boot payload, or the document.
if (typeof window !== 'undefined') start()
