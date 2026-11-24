/**
 * One shared DSH host serving every VS Code window of one extension storage.
 *
 * The server owns the listening socket, the authentication handshake, and the
 * connection registry. It does not boot DSH itself: {@link SharedHostServerOptions.createSession}
 * builds the per-window transport session (typically one `WebviewBridge` over
 * the same application context), and the caller owns the application, idle
 * shutdown, and spawn lock.
 *
 * Each connection carries its own request-id space and its own Session peer, so
 * two windows can observe the same Session without sharing upload or stream
 * state. Replies go back only to the connection that sent the request; nothing
 * is broadcast here.
 *
 * @module @deepseek-ai/dsh-vscode/companion/server
 */
import { timingSafeEqual } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { HOST_PROTOCOL_VERSION } from '../shared/host-endpoint.ts'
import {
  parseHostHello,
  type HostHello,
  type HostHelloOk,
  type HostHelloRejected,
  type HostRejectionCode,
} from '../shared/host-protocol.ts'

/** Largest single line one connection may send, in bytes. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** How long a connection may stay silent before its handshake is refused. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/** Frames buffered while one connection's Session is being created. */
const MAX_PENDING_FRAMES = 64

/** The connection surface a transport session writes to. */
export interface HostConnection {
  /** Identity the host assigned to this connection. */
  readonly id: string
  /**
   * Deliver one frame to this connection's window.
   * @param frame - JSON-serializable frame.
   */
  send(frame: unknown): void
  /** Stop this connection; the host disposes its Session and notifies when idle. */
  close(): void
}

/** One window's transport session inside the shared host. */
export interface HostSession {
  /** Boot payload the window embeds; paths stay local for the extension to map. */
  readonly ready: unknown
  /** Register capabilities after the readiness frame is sent. */
  onReady?(): void
  /**
   * Handle one decoded frame that belongs to this connection.
   * @param frame - decoded JSON frame.
   * @returns completion of dispatch. For a unary fetch this includes the Host
   * method settling, even when the connection disappears before the reply.
   */
  handle(frame: unknown): Promise<void>
  /** Release every stream, upload, and peer this connection created. */
  dispose(): void | Promise<void>
}

/** Inputs for one shared host listener. */
export interface SharedHostServerOptions {
  /** Named pipe or socket path to listen on. */
  readonly endpoint: string
  /** Credential every hello must present. */
  readonly token: string
  /** Random identity of this host process, reported in every admittance. */
  readonly instanceId: string
  /** DSH release this host booted, reported in every admittance. */
  readonly dshVersion: string
  /** Deployment settings fingerprint this host booted with. */
  readonly configFingerprint: string
  /** Build the transport session for one admitted window. */
  readonly createSession: (hello: HostHello, connection: HostConnection) => Promise<HostSession>
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** Called once after the last connection closed. */
  readonly onIdle?: () => void
  /** Remove a socket left by a host that exited without cleaning up (POSIX). */
  readonly staleSocketPath?: string
  /** Protocol version this build speaks; defaults to {@link HOST_PROTOCOL_VERSION}. */
  readonly protocolVersion?: number
  /** Concurrent window connections the host accepts; defaults to 16. */
  readonly maxConnections?: number
}

/** One live or handshaking connection. */
interface ConnectionState {
  readonly socket: Socket
  id: string | undefined
  buffered: Buffer
  admitted: boolean
  closed: boolean
  session: HostSession | undefined
  handshaking: boolean
  readonly pending: unknown[]
  timer: NodeJS.Timeout | undefined
}

/** Default number of windows one host admits at the same time. */
const DEFAULT_MAX_CONNECTIONS = 16

/** Listener, handshake, and connection registry of one shared host. */
export class SharedHostServer {
  private server: Server | undefined
  private readonly connections = new Map<string, ConnectionState>()
  private readonly all = new Set<ConnectionState>()
  private sequence = 0
  private closing = false
  private idleNotified = false

  /** @param options - listener, authentication, and session construction inputs. */
  constructor(private readonly options: SharedHostServerOptions) {}

  /** Number of admitted connections, for status reporting and tests. */
  get connectionCount(): number {
    return this.connections.size
  }

  /**
   * Bind the endpoint and start accepting windows.
   * @returns settles once the listener is bound.
   * @throws when the endpoint cannot be bound.
   */
  async listen(): Promise<void> {
    const stale = this.options.staleSocketPath
    if (stale !== undefined) {
      try {
        unlinkSync(stale)
      } catch {
        // No stale socket file is the normal case; binding below reports a real
        // conflict with a host that is still listening.
      }
    }
    const server = createServer((socket) => { this.accept(socket) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.endpoint)
    })
    this.options.log(`dsh host: listening on ${this.options.endpoint}`)
  }

  /**
   * Stop listening and close every connection.
   * @returns settles after the listener closed and sessions were disposed.
   */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const server = this.server
    this.server = undefined
    await Promise.all([...this.all].map(async (connection) => { await this.drop(connection, 'the host is stopping') }))
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    }
    const stale = this.options.staleSocketPath
    if (stale !== undefined) {
      try {
        unlinkSync(stale)
      } catch {
        // The socket file is already gone; nothing to clean up.
      }
    }
  }

  /**
   * Register one accepted socket and start its handshake deadline.
   * @param socket - accepted connection.
   */
  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy()
      return
    }
    if (this.all.size >= (this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
      // Refuse before reading a hello: the host is at capacity, and the client
      // must not believe a Session was created for it.
      this.writeTo(socket, {
        type: 'hello-rejected',
        code: 'capacity',
        message: 'dsh: the shared DSH host has no free connection slot; close another VS Code window and try again.',
      } satisfies HostHelloRejected)
      socket.end()
      return
    }
    const connection: ConnectionState = {
      socket,
      id: undefined,
      buffered: Buffer.alloc(0),
      admitted: false,
      closed: false,
      session: undefined,
      handshaking: false,
      pending: [],
      timer: undefined,
    }
    this.all.add(connection)
    this.idleNotified = false
    connection.timer = setTimeout(() => {
      this.options.log('dsh host: a connection did not complete its handshake in time')
      void this.drop(connection, 'the handshake timed out')
    }, HANDSHAKE_TIMEOUT_MS)
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => { this.consume(connection, chunk) })
    socket.on('error', (error: Error) => {
      this.options.log(`dsh host: a connection failed: ${error.message}`)
    })
    socket.on('close', () => { void this.drop(connection, 'the connection closed') })
  }

  /**
   * Decode complete lines from one socket and dispatch them.
   * @param connection - the sending connection.
   * @param chunk - newly received bytes.
   */
  private consume(connection: ConnectionState, chunk: Buffer): void {
    if (connection.closed) return
    connection.buffered = connection.buffered.length === 0 ? chunk : Buffer.concat([connection.buffered, chunk])
    while (true) {
      const newline = connection.buffered.indexOf(0x0a)
      if (newline < 0) break
      const line = connection.buffered.subarray(0, newline)
      connection.buffered = connection.buffered.subarray(newline + 1)
      if (line.length > MAX_FRAME_BYTES) {
        this.options.log(`dsh host: a frame exceeded ${String(MAX_FRAME_BYTES)} bytes; the connection was closed`)
        void this.drop(connection, 'the frame was too large')
        return
      }
      this.dispatch(connection, line)
    }
    if (connection.buffered.length > MAX_FRAME_BYTES) {
      this.options.log(`dsh host: an unterminated frame exceeded ${String(MAX_FRAME_BYTES)} bytes; the connection was closed`)
      void this.drop(connection, 'the frame was too large')
    }
  }

  /**
   * @param connection - the sending connection.
   * @param line - one complete JSON line.
   */
  private dispatch(connection: ConnectionState, line: Buffer): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line.toString('utf8'))
    } catch {
      // A malformed line before admittance is a protocol failure; after it, the
      // Session reports the unknown frame and keeps the connection usable.
      if (!connection.admitted) {
        this.reject(connection, 'protocol', 'dsh: the first frame was not valid JSON.')
        return
      }
      this.options.log('dsh host: an unreadable frame was ignored')
      return
    }
    if (connection.handshaking) {
      // The hello was accepted and its Session is being prepared. The window
      // must not send transport frames before `ready`, but a frame that races
      // that answer is queued rather than treated as a second hello.
      this.bufferPending(connection, decoded)
      return
    }
    if (!connection.admitted) {
      void this.admit(connection, decoded)
      return
    }
    const session = connection.session
    if (session === undefined) {
      this.bufferPending(connection, decoded)
      return
    }
    this.deliver(connection, session, decoded)
  }

  /**
   * Queue one frame until its connection has a Session.
   * @param connection - the sending connection.
   * @param frame - decoded frame.
   */
  private bufferPending(connection: ConnectionState, frame: unknown): void {
    if (connection.pending.length >= MAX_PENDING_FRAMES) {
      void this.drop(connection, 'too many frames arrived before its session was ready')
      return
    }
    connection.pending.push(frame)
  }

  /**
   * Validate the first frame and build the connection's Session.
   * @param connection - the handshaking connection.
   * @param value - decoded first frame.
   */
  private async admit(connection: ConnectionState, value: unknown): Promise<void> {
    const hello = parseHostHello(value)
    if (hello === undefined) {
      this.reject(connection, 'protocol', 'dsh: the connection did not start with a valid hello frame.')
      return
    }
    if (!this.tokenMatches(hello.token)) {
      this.reject(connection, 'token', 'dsh: the shared DSH host refused this window: its access token is stale. Reload the window and try again.')
      return
    }
    const protocol = this.options.protocolVersion ?? HOST_PROTOCOL_VERSION
    if (hello.protocol !== protocol) {
      this.reject(connection, 'protocol', `dsh: this window speaks shared-host protocol ${String(hello.protocol)} but the running host speaks ${String(protocol)}. Reload the window after the extension updates.`)
      return
    }
    connection.handshaking = true
    try {
      await this.establishSession(connection, hello)
    } catch (error) {
      this.options.log(`dsh host: admitting a window failed: ${describe(error)}`)
      await this.drop(connection, 'its session could not be created')
    }
  }

  /**
   * @param connection - admitted connection.
   * @param hello - validated hello.
   */
  private async establishSession(connection: ConnectionState, hello: HostHello): Promise<void> {
    if (this.closing) return
    const id = `connection-${String(++this.sequence)}`
    connection.id = id
    this.connections.set(id, connection)
    this.clearTimer(connection)
    const send = (frame: unknown): void => { this.writeTo(connection.socket, frame) }
    let session: HostSession
    try {
      session = await this.options.createSession(hello, {
        id,
        send,
        close: () => { void this.drop(connection, 'the window closed its connection') },
      })
    } catch (error) {
      this.options.log(`dsh host: session creation failed: ${describe(error)}`)
      this.reject(connection, 'capacity', 'dsh: the shared DSH host could not prepare this window; see the DSH log for the failure.')
      return
    }
    if (connection.closed) {
      await session.dispose()
      return
    }
    connection.session = session
    connection.admitted = true
    const answer: HostHelloOk = {
      type: 'hello-ok',
      protocol: this.options.protocolVersion ?? HOST_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      connectionId: id,
      dshVersion: this.options.dshVersion,
      configFingerprint: this.options.configFingerprint,
    }
    send(answer)
    send({ type: 'ready', payload: session.ready })
    session.onReady?.()
    this.options.log(`dsh host: window ${hello.clientId} connected as ${id}`)
    // No await between clearing the flag and flushing: a frame that raced the
    // handshake is either queued before this turn or delivered after it.
    connection.handshaking = false
    for (const frame of connection.pending.splice(0)) this.deliver(connection, session, frame)
  }

  /**
   * @param connection - admitted connection.
   * @param session - its transport session.
   * @param frame - decoded frame.
   */
  private deliver(connection: ConnectionState, session: HostSession, frame: unknown): void {
    void session.handle(frame).catch((error: unknown) => {
      this.options.log(`dsh host: a frame from ${connection.id ?? 'a window'} failed: ${describe(error)}`)
    })
  }

  /**
   * Refuse one connection with a handshake answer and close it.
   * @param connection - the connection to refuse.
   * @param code - stable refusal reason.
   * @param message - user-facing explanation.
   */
  private reject(connection: ConnectionState, code: HostRejectionCode, message: string): void {
    this.writeTo(connection.socket, { type: 'hello-rejected', code, message } satisfies HostHelloRejected)
    void this.drop(connection, message)
  }

  /**
   * Release one connection: its Session, socket, registry entry, and the idle
   * notification when it was the last one.
   * @param connection - the connection to release.
   * @param reason - why it is being released.
   */
  private async drop(connection: ConnectionState, reason: string): Promise<void> {
    if (connection.closed) return
    connection.closed = true
    this.clearTimer(connection)
    this.all.delete(connection)
    if (connection.id !== undefined) this.connections.delete(connection.id)
    const session = connection.session
    connection.session = undefined
    if (session !== undefined) {
      try {
        await session.dispose()
      } catch (error) {
        this.options.log(`dsh host: disposing ${connection.id ?? 'a connection'} failed: ${describe(error)}`)
      }
    }
    connection.socket.destroy()
    this.options.log(`dsh host: ${connection.id ?? 'a handshaking connection'} closed: ${reason}`)
    if (!this.closing && this.connections.size === 0 && !this.idleNotified) {
      this.idleNotified = true
      this.options.onIdle?.()
    }
  }

  /**
   * End a connection's handshake deadline.
   * @param connection - connection whose deadline should end.
   */
  private clearTimer(connection: ConnectionState): void {
    if (connection.timer !== undefined) {
      clearTimeout(connection.timer)
      connection.timer = undefined
    }
  }

  /**
   * @param presented - token from one hello.
   * @returns whether it equals the host token without leaking its length.
   */
  private tokenMatches(presented: string): boolean {
    const expected = Buffer.from(this.options.token, 'utf8')
    const actual = Buffer.from(presented, 'utf8')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /**
   * Write one JSON line to a socket that may already be closing.
   * @param socket - target socket.
   * @param frame - frame to encode.
   */
  private writeTo(socket: Socket, frame: unknown): void {
    if (socket.destroyed) return
    try {
      socket.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      this.options.log(`dsh host: a frame could not be written: ${describe(error)}`)
    }
  }
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
