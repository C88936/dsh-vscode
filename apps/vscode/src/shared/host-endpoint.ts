/**
 * Local endpoint one shared DSH host listens on.
 *
 * Every VS Code window that shares the same extension storage connects to the
 * same endpoint, so the name must be derived from that storage instead of a
 * random per-launch value. Windows uses a named pipe, whose name is
 * machine-global and therefore carries the storage digest; POSIX uses a socket
 * file in the temporary directory because a global-storage path can exceed the
 * platform's socket-path length.
 *
 * The endpoint name is not a credential: any local process can try the same
 * pipe. The token file next to this activation's runtime files is the
 * credential, and the host refuses a connection whose hello does not present it.
 *
 * @module @deepseek-ai/dsh-vscode/shared/host-endpoint
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Protocol version both halves of the shared host connection speak. */
export const HOST_PROTOCOL_VERSION = 1

/** Directory below extension storage that holds runtime host files. */
const RUNTIME_DIR = 'runtime'

/** Longest token the host accepts, in characters; also the format's exact length. */
const TOKEN_LENGTH = 64

/** Token format written by {@link createHostToken}. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u

/** One host endpoint and the files that scope access to it. */
export interface HostEndpoint {
  /** Listener name: a named-pipe path on Windows, a socket path elsewhere. */
  readonly endpoint: string
  /** Directory holding the token, the spawn lock, and per-connection resources. */
  readonly runtimeDir: string
  /** Authentication token file every client reads before connecting. */
  readonly tokenPath: string
  /** Spawn lock taken by the window that starts the host. */
  readonly lockPath: string
  /** Socket file the listener owns, on platforms that use one. */
  readonly socketPath: string | undefined
  /** Whether the listener binds a filesystem socket rather than a named pipe. */
  readonly transport: 'pipe' | 'unix'
}

/**
 * Resolve the endpoint and runtime files for one extension storage directory.
 *
 * The digest is case-folded on Windows and the path is absolute, so two windows
 * that name the same storage differently still share one host instead of each
 * starting one.
 * @param storageDir - extension storage directory (`globalStorageUri.fsPath`).
 * @returns the endpoint and its runtime files.
 */
export function resolveHostEndpoint(storageDir: string): HostEndpoint {
  const absolute = resolve(storageDir)
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  const runtimeDir = join(absolute, RUNTIME_DIR)
  const tokenPath = join(runtimeDir, 'host.token')
  const lockPath = join(runtimeDir, 'host.lock')
  if (process.platform === 'win32') {
    return {
      endpoint: `\\\\.\\pipe\\dsh-vscode-v${String(HOST_PROTOCOL_VERSION)}-${digest}`,
      runtimeDir,
      tokenPath,
      lockPath,
      socketPath: undefined,
      transport: 'pipe',
    }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const socketPath = join(tmpdir(), `dsh-vscode-v${String(HOST_PROTOCOL_VERSION)}-${String(uid)}-${digest}.sock`)
  return {
    endpoint: socketPath,
    runtimeDir,
    tokenPath,
    lockPath,
    socketPath,
    transport: 'unix',
  }
}

/**
 * Read the token a running host published for this storage.
 * @param tokenPath - token file below the runtime directory.
 * @returns the token, or undefined when no valid token file exists.
 */
export function readHostToken(tokenPath: string): string | undefined {
  let text: string
  try {
    text = readFileSync(tokenPath, 'utf8').trim()
  } catch {
    // A missing or unreadable token file means no host published one yet; the
    // caller starts the host, which then publishes it.
    return undefined
  }
  return isHostToken(text) ? text : undefined
}

/**
 * Publish the token this storage's host requires, or keep the one already
 * published.
 *
 * Two windows can race here before the spawn lock is taken. Keeping an existing
 * valid token makes both of them present the same credential to whichever host
 * wins; replacing it would invalidate a client that already connected.
 * @param tokenPath - token file below the runtime directory.
 * @returns the token every client of this storage presents.
 */
export function createHostToken(tokenPath: string): string {
  const existing = readHostToken(tokenPath)
  if (existing !== undefined) return existing
  mkdirSync(dirname(tokenPath), { recursive: true })
  const token = randomBytes(TOKEN_LENGTH / 2).toString('hex')
  // The file is readable by this user only. Windows ignores the mode; the
  // global-storage directory's ACL is what scopes it there.
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return token
}

/**
 * @param value - token presented in one hello frame.
 * @returns whether it has the published token's format.
 */
export function isHostToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}
