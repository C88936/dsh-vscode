/**
 * Native resource opening for a page whose carrier owns the editor.
 *
 * The VS Code webview has no in-page document surface: its carrier installs
 * `openResource` on the page transport, and the sidebar then resolves a file
 * address to the absolute path the editor needs instead of claiming a tab. A
 * served Web page carries no such hook and keeps the in-page surface, so the
 * composition decides by capability rather than by a page-detectable mode.
 * @module
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * A resource the carrier opens in its host surface. Mirrors the carrier hook's
 * request (`OpenResourceRequest` on the page transport); declared here so this
 * package needs no import from the transport package it is bootstrapped with.
 */
export interface NativeOpenRequest {
  /** The `dsh-resource://` address that produced the request. */
  readonly address: string
  /** Absolute filesystem path, present when the address names a resolvable file. */
  readonly path?: string
  /** 1-based line to reveal. */
  readonly line?: number
}

/** The carrier hooks this package consumes when the page has no document surface. */
export interface NativeOpenTransport {
  /** Open one resource request in the host's editor. */
  readonly openResource: (request: NativeOpenRequest) => void | Promise<void>
  /** Open an external URL in the host's browser; absent when the host has none. */
  readonly openExternal?: (url: string) => void | Promise<void>
}

/** Inputs for resolving one address to a native request. */
export interface NativeResourceInput {
  /** The address the caller asked to open. */
  readonly address: string
  /** Session whose workspace root resolves a session-scoped path. */
  readonly sessionId?: SessionId
  /** That Session's working directory, when the page knows it. */
  readonly cwd?: string
  /** 1-based line the caller asked to reveal. */
  readonly line?: number
}

/**
 * Read the carrier's native opening hooks.
 * @param globals - page global object; defaults to `globalThis`.
 * @returns the hooks, or undefined for a page with an in-page document surface.
 */
export function nativeOpenTransport(globals: object = globalThis): NativeOpenTransport | undefined {
  const transport = (globals as { __DSH_TRANSPORT__?: { openResource?: unknown; openExternal?: unknown } }).__DSH_TRANSPORT__
  if (transport === undefined || typeof transport.openResource !== 'function') return undefined
  const openResource = transport.openResource as NativeOpenTransport['openResource']
  const openExternal = typeof transport.openExternal === 'function'
    ? transport.openExternal as NonNullable<NativeOpenTransport['openExternal']>
    : undefined
  return openExternal === undefined ? { openResource } : { openResource, openExternal }
}

/**
 * Resolve one resource address into the absolute path a native editor opens.
 * @param input - address, Session identity, its working directory, and line.
 * @returns the request to hand to the carrier; a file address without a
 *   resolvable root or an address that is not a file keeps only its address.
 */
export function nativeResourceRequest(input: NativeResourceInput): NativeOpenRequest {
  const parsed = parseFileAddress(input.address)
  const line = input.line === undefined ? {} : { line: input.line }
  if (parsed === undefined) return { address: input.address, ...line }
  if (parsed.scope === 'absolute') return { address: input.address, path: parsed.path, ...line }
  const cwd = input.cwd
  if (cwd === undefined || cwd === '') return { address: input.address, ...line }
  return { address: input.address, path: resolveWorkspacePath(cwd, parsed.path), ...line }
}

/**
 * Read the Session a session-scoped file address names.
 * @param address - candidate resource address.
 * @returns that Session's id, or undefined for an absolute or non-file address.
 */
export function addressSessionId(address: string): SessionId | undefined {
  const parsed = parseFileAddress(address)
  return parsed?.scope === 'session' ? parsed.sessionId as SessionId : undefined
}

/**
 * Read the 1-based line from resource navigation parameters the opening type declares.
 * @param params - parameters as the opening caller typed them.
 * @returns the line to reveal, or undefined when the parameters carry none.
 */
export function navigationLine(params: unknown): number | undefined {
  if (params === null || typeof params !== 'object' || !('line' in params)) return undefined
  return typeof params.line === 'number' ? params.line : undefined
}
