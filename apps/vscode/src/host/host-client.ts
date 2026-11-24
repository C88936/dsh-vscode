/**
 * Window side of one shared DSH host connection.
 *
 * A VS Code window no longer owns a companion process. It connects to the
 * shared host, proves it may use it with the storage token, and then forwards
 * the same Webview frames the per-window companion carried over stdin/stdout.
 * This module owns only framing and the handshake; frame validation and routing
 * stay with the caller that drives a WebviewBridge.
 *
 * @module @deepseek-ai/dsh-vscode/host/host-client
 */
import { connect, type Socket } from 'node:net'
import { HOST_PROTOCOL_VERSION } from '../shared/host-endpoint.ts'
import {
  isHostHelloOk,
  isHostHelloRejected,
  isHostReady,
  type HostHelloOk,
  type HostRejectionCode,
} from '../shared/host-protocol.ts'
import type { BridgeLimits } from '../shared/limits.ts'

/** Largest line the client accepts from the host, in bytes. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** Default deadline for the host's admission answer. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000

/** Inputs for one window connection. */
export interface SharedHostClientOptions {
  /** Host endpoint: a named pipe or a socket path. */
  readonly endpoint: string
  /** Credential published by the storage. */
  readonly token: string
  /** Stable identity of this window activation, for the host log. */
  readonly clientId: string
  /** Extension version reported during the handshake. */
  readonly extensionVersion: string
  /** Deployment settings fingerprint this window would boot with. */
  readonly configFingerprint: string
  /** Bounded-transfer budgets this window's Webview enforces. */
  readonly limits: BridgeLimits
  /** Workspace folder this window shows, when it has one. */
  readonly workspacePath?: string
  /** Receives every frame after the boot payload, exactly as the companion sent them. */
  readonly onFrame: (frame: unknown) => void
  /** Reports that the transport ended; called once. */
  readonly onClose?: (reason: string) => void
  /** Diagnostic sink. */
  readonly log?: (line: string) => void
  /** Protocol version this extension speaks; defaults to the host protocol. */
  readonly protocolVersion?: number
  /** Handshake deadline; defaults to 15 seconds. */
  readonly handshakeTimeoutMs?: number
}

/** A host refusal that prevents this window from using the shared application. */
export class HostRefusedError extends Error {
  /**
   * @param code - stable refusal reason.
   * @param message - user-facing explanation.
   */
  constructor(readonly code: HostRejectionCode, message: string) {
    super(message)
    this.name = 'HostRefusedError'
  }
}

/** One admitted connection to the shared host. */
export interface SharedHostConnection {
  /** The host's admission answer. */
  readonly hello: HostHelloOk
  /** Boot payload the window embeds; paths stay local for the extension to map. */
  readonly ready: unknown
  /** Whether the transport has ended. */
  readonly closed: boolean
  /**
   * Send one Webview frame to the host.
   * @param frame - JSON-serializable frame.
   */
  send(frame: unknown): void
  /** End this window's connection and release the socket. */
  close(): void
}

/** Connection implementation over one socket. */
class SocketHostConnection implements SharedHostConnection {
  private pendingHello: HostHelloOk | undefined
  private admitted: { readonly hello: HostHelloOk; readonly ready: unknown } | undefined
  private ended = false
  private settleHandshake: ((answer: { hello: HostHelloOk; ready: unknown }) => void) | undefined
  private failHandshake: ((error: Error) => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private buffered: Buffer = Buffer.alloc(0)

  /**
   * @param socket - connected socket.
   * @param options - window identity and frame sink.
   */
  constructor(
    private readonly socket: Socket,
    private readonly options: SharedHostClientOptions,
  ) {}

  get closed(): boolean {
    return this.ended
  }

  get hello(): HostHelloOk {
    if (this.admitted === undefined) throw new Error('dsh: the shared host connection was not admitted')
    return this.admitted.hello
  }

  get ready(): unknown {
    if (this.admitted === undefined) throw new Error('dsh: the shared host connection was not admitted')
    return this.admitted.ready
  }

  /**
   * Send the hello and resolve once the host admitted this window and delivered
   * the boot payload.
   * @param hello - handshake frame.
   * @returns this connection.
   */
  async open(hello: unknown): Promise<SharedHostConnection> {
    const settled = new Promise<{ hello: HostHelloOk; ready: unknown }>((resolve, reject) => {
      this.settleHandshake = resolve
      this.failHandshake = reject
    })
    this.timer = setTimeout(() => {
      this.fail(new Error(`dsh: the shared DSH host at ${this.options.endpoint} did not answer the handshake within ${String(this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)} ms`))
    }, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)
    this.socket.on('data', (chunk: Buffer) => { this.consume(chunk) })
    this.socket.on('error', (error: Error) => { this.fail(error) })
    this.socket.on('close', () => { this.fail(new Error(`dsh: the shared DSH host at ${this.options.endpoint} closed the connection`)) })
    this.socket.setNoDelay(true)
    this.send(hello)
    const answer = await settled
    this.admitted = answer
    return this
  }

  send(frame: unknown): void {
    if (this.ended) return
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.clearTimer()
    this.socket.destroy()
    this.options.onClose?.('the window closed its connection')
  }

  /**
   * Decode complete lines from the host.
   * @param chunk - newly received bytes.
   */
  private consume(chunk: Buffer): void {
    if (this.ended) return
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    while (true) {
      const newline = this.buffered.indexOf(0x0a)
      if (newline < 0) break
      const line = this.buffered.subarray(0, newline)
      this.buffered = this.buffered.subarray(newline + 1)
      if (line.length > MAX_FRAME_BYTES) {
        this.fail(new Error('dsh: the shared DSH host sent a frame above the transport limit'))
        return
      }
      this.dispatch(line.toString('utf8'))
    }
    if (this.buffered.length > MAX_FRAME_BYTES) {
      this.fail(new Error('dsh: the shared DSH host sent an unterminated frame above the transport limit'))
    }
  }

  /**
   * Route one decoded frame to the handshake or the Webview transport.
   * @param line - one JSON line.
   */
  private dispatch(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      this.options.log?.('dsh: the shared DSH host sent an unreadable frame; it was ignored')
      return
    }
    if (this.admitted === undefined) {
      this.handshakeFrame(decoded)
      return
    }
    this.options.onFrame(decoded)
  }

  /**
   * Apply one pre-admission frame.
   * @param frame - decoded frame.
   */
  private handshakeFrame(frame: unknown): void {
    if (isHostHelloRejected(frame)) {
      this.fail(new HostRefusedError(frame.code, frame.message))
      return
    }
    if (isHostHelloOk(frame)) {
      const hello = frame
      const protocol = this.options.protocolVersion ?? HOST_PROTOCOL_VERSION
      if (hello.protocol !== protocol) {
        this.fail(new HostRefusedError(
          'protocol',
          `dsh: the shared DSH host speaks protocol ${String(hello.protocol)} but this extension speaks ${String(protocol)}. Reload the window after the extension updates.`,
        ))
        return
      }
      this.pendingHello = hello
      return
    }
    if (isHostReady(frame)) {
      const pending = this.pendingHello
      if (pending === undefined) {
        this.fail(new Error('dsh: the shared DSH host sent the boot payload before admitting the window'))
        return
      }
      const answer = { hello: pending, ready: frame.payload }
      this.admitted = answer
      this.clearTimer()
      this.settleHandshake?.(answer)
      this.settleHandshake = undefined
      this.failHandshake = undefined
      return
    }
    this.options.log?.('dsh: the shared DSH host sent an unknown handshake frame')
  }

  /**
   * End the connection after a failure and report it to the pending handshake
   * or the established transport.
   * @param error - why the transport cannot continue.
   */
  private fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.clearTimer()
    this.socket.destroy()
    const pending = this.failHandshake
    this.settleHandshake = undefined
    this.failHandshake = undefined
    if (pending !== undefined) {
      pending(error)
      return
    }
    this.options.log?.(`dsh: shared host connection ended: ${error.message}`)
    this.options.onClose?.(error.message)
  }

  /** Clear the handshake deadline. */
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/**
 * Open one connection to a running shared host.
 *
 * The caller decides whether a host exists first (`ensureSharedHost`); this
 * function only reports the refusal or the boot payload. A failed connection is
 * always destroyed, so a window that could not be admitted leaves no half-open
 * socket behind.
 * @param options - endpoint, identity, and frame sink.
 * @returns the admitted connection.
 * @throws {@link HostRefusedError} when the host refuses this window.
 * @throws when the endpoint is unreachable or the handshake fails.
 */
export async function connectSharedHost(options: SharedHostClientOptions): Promise<SharedHostConnection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pending = connect(options.endpoint)
    pending.once('connect', () => { resolve(pending) })
    pending.once('error', (error: Error) => {
      pending.destroy()
      reject(new Error(`dsh: the shared DSH host is not reachable at ${options.endpoint}: ${error.message}`))
    })
  })
  const connection = new SocketHostConnection(socket, options)
  return await connection.open({
    type: 'hello',
    protocol: options.protocolVersion ?? HOST_PROTOCOL_VERSION,
    token: options.token,
    clientId: options.clientId,
    extensionVersion: options.extensionVersion,
    ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
    configFingerprint: options.configFingerprint,
    limits: options.limits,
  })
}
