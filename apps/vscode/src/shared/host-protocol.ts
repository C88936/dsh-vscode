/**
 * Frames the shared host and its window clients exchange before the Webview
 * transport starts.
 *
 * The handshake is a separate, small protocol because a client that presents a
 * stale token or speaks an older protocol must be refused before any Session,
 * stream, or upload state exists in the host. Once the host answers
 * `hello-ok`, both halves carry the same frames the per-window companion used,
 * one connection per window.
 *
 * @module @deepseek-ai/dsh-vscode/shared/host-protocol
 */
import { readBridgeLimits, type BridgeLimits } from './limits.ts'

/** First frame a window sends on one connection. */
export interface HostHello {
  /** Frame tag. */
  readonly type: 'hello'
  /** Protocol version the client speaks. */
  readonly protocol: number
  /** Credential published in the storage's token file. */
  readonly token: string
  /** Stable identity of this window's extension activation, for diagnostics. */
  readonly clientId: string
  /** Extension version, reported by the host log. */
  readonly extensionVersion: string
  /** Workspace folder this window currently shows, when it has one. */
  readonly workspacePath?: string
  /** Deployment settings fingerprint this window would boot with. */
  readonly configFingerprint: string
  /** Bounded-transfer budgets this window's Webview enforces. */
  readonly limits: BridgeLimits
}

/** Host answer that admits one connection. */
export interface HostHelloOk {
  /** Frame tag. */
  readonly type: 'hello-ok'
  /** Protocol version the host speaks. */
  readonly protocol: number
  /** Random identity of this host process, stable until it exits. */
  readonly instanceId: string
  /** Identity the host assigned to this connection. */
  readonly connectionId: string
  /** DSH release the shared host booted. */
  readonly dshVersion: string
  /** Deployment settings fingerprint the running host booted with. */
  readonly configFingerprint: string
}

/** Why a host refused one connection. */
export type HostRejectionCode = 'protocol' | 'token' | 'capacity'

/** Host answer that closes one connection before any transport frame. */
export interface HostHelloRejected {
  /** Frame tag. */
  readonly type: 'hello-rejected'
  /** Stable refusal reason. */
  readonly code: HostRejectionCode
  /** User-facing explanation naming the recovery path. */
  readonly message: string
}

/** Boot payload carrier; the payload itself is the Webview boot graph. */
export interface HostReady {
  /** Frame tag. */
  readonly type: 'ready'
  /** Payload the page embeds; the extension maps its paths to Webview URIs. */
  readonly payload: unknown
}

/** Running work one window asks the host to report. */
export interface HostActivityCounts {
  /** Live Agents running a turn. */
  readonly runningTurns: number
  /** Package-manager operations announced as started and not settled. */
  readonly packageOperations: number
  /** Running DSH terminal commands inside the host process. */
  readonly runningTerminals: number
}

/**
 * Deployment model configuration the shared host booted with.
 *
 * Every window displays this rather than its own saved settings: the host
 * runs one application, so its route and model are the effective ones even in
 * a window that would launch differently.
 */
export interface HostModelConfig {
  /** Route the application selects, such as `company` or `deepseek-official`. */
  readonly provider: string
  /** Model id the route serves; empty when the deployment names none. */
  readonly model: string
  /** Whether the running application has a usable model. */
  readonly configured: boolean
}

/** Query one window sends for the host's deployment model configuration. */
export interface HostConfigRequest {
  /** Frame tag. */
  readonly type: 'host-config'
  /** Request id the answer echoes. */
  readonly id: number
}

/** Answer the host sends for one model-configuration query. */
export interface HostConfigAnswer {
  /** Frame tag. */
  readonly type: 'host-config-result'
  /** Id of the query this answers. */
  readonly id: number
  /** Configuration the running application booted with. */
  readonly config: HostModelConfig
}

/** Query one window sends for the shared host's running work. */
export interface HostActivityRequest {
  /** Frame tag. */
  readonly type: 'host-activity'
  /** Request id the answer echoes. */
  readonly id: number
}

/** Answer the host sends for one activity query. */
export interface HostActivityAnswer {
  /** Frame tag. */
  readonly type: 'host-activity-result'
  /** Id of the query this answers. */
  readonly id: number
  /** Running work the host owns, across every window. */
  readonly activity: HostActivityCounts
}

/** Query one window sends to stop the shared host for maintenance. */
export interface HostShutdownRequest {
  /** Frame tag. */
  readonly type: 'host-shutdown'
  /** Request id the answer echoes. */
  readonly id: number
}

/** Answer to one maintenance-stop request. */
export interface HostShutdownAnswer {
  /** Frame tag. */
  readonly type: 'host-shutdown-result'
  /** Id of the request this answers. */
  readonly id: number
  /** Whether the host accepted the stop and is shutting down. */
  readonly ok: boolean
  /** Why the stop was refused, when `ok` is false. */
  readonly error?: string
}

/**
 * Notice the host sends every connected window when maintenance admission
 * changes.
 *
 * A window that did not request the stop still needs to know that new turns are
 * refused while it is applied; the frame carries no id because it answers no
 * request.
 */
export interface HostMaintenanceNotice {
  /** Frame tag. */
  readonly type: 'host-maintenance'
  /** Whether maintenance admission is closed right now. */
  readonly active: boolean
  /** Why admission changed, for the window's log. */
  readonly reason?: string
}

/** Longest accepted identity or version string in a hello, in characters. */
const MAX_LABEL_LENGTH = 200

/** Longest accepted configuration fingerprint, in characters. */
const MAX_FINGERPRINT_LENGTH = 512

/**
 * Validate one decoded hello before the host creates any connection state.
 * @param value - decoded first frame.
 * @returns the hello, or undefined when a required field is missing or malformed.
 */
export function parseHostHello(value: unknown): HostHello | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (frame.type !== 'hello') return undefined
  if (typeof frame.protocol !== 'number' || !Number.isInteger(frame.protocol) || frame.protocol < 0) return undefined
  if (typeof frame.token !== 'string' || frame.token.length === 0 || frame.token.length > 256) return undefined
  const clientId = label(frame.clientId)
  const extensionVersion = label(frame.extensionVersion)
  const configFingerprint = fingerprint(frame.configFingerprint)
  if (clientId === undefined || extensionVersion === undefined || configFingerprint === undefined) return undefined
  if (frame.workspacePath !== undefined && label(frame.workspacePath) === undefined) return undefined
  const limits = readBridgeLimits(frame.limits)
  if (limits === undefined) return undefined
  return {
    type: 'hello',
    protocol: frame.protocol,
    token: frame.token,
    clientId,
    extensionVersion,
    configFingerprint,
    ...frame.workspacePath === undefined ? {} : { workspacePath: frame.workspacePath as string },
    limits,
  }
}

/**
 * @param value - decoded host frame.
 * @returns whether it is a complete admission answer.
 */
export function isHostHelloOk(value: unknown): value is HostHelloOk {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  return frame.type === 'hello-ok'
    && typeof frame.protocol === 'number'
    && Number.isInteger(frame.protocol)
    && label(frame.instanceId) !== undefined
    && label(frame.connectionId) !== undefined
    && typeof frame.dshVersion === 'string'
    && fingerprint(frame.configFingerprint) !== undefined
}

/**
 * @param value - decoded host frame.
 * @returns whether it is a complete refusal.
 */
export function isHostHelloRejected(value: unknown): value is HostHelloRejected {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  const code = frame.code
  return frame.type === 'hello-rejected'
    && (code === 'protocol' || code === 'token' || code === 'capacity')
    && typeof frame.message === 'string'
}

/**
 * @param value - decoded value.
 * @returns whether it is a boot-payload frame.
 */
export function isHostReady(value: unknown): value is HostReady {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'ready'
    && 'payload' in value
}

/**
 * @param value - decoded frame.
 * @returns whether it is one activity query.
 */
export function isHostActivityRequest(value: unknown): value is HostActivityRequest {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown }
  return frame.type === 'host-activity' && typeof frame.id === 'number' && Number.isInteger(frame.id)
}

/**
 * @param value - decoded frame.
 * @returns whether it is one model-configuration query.
 */
export function isHostConfigRequest(value: unknown): value is HostConfigRequest {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown }
  return frame.type === 'host-config' && typeof frame.id === 'number' && Number.isInteger(frame.id)
}

/**
 * @param value - decoded frame.
 * @returns whether it is one complete model-configuration answer.
 */
export function isHostConfigAnswer(value: unknown): value is HostConfigAnswer {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown; config?: unknown }
  if (frame.type !== 'host-config-result' || typeof frame.id !== 'number' || !Number.isInteger(frame.id)) return false
  const config = frame.config
  if (typeof config !== 'object' || config === null) return false
  const fields = config as { provider?: unknown; model?: unknown; configured?: unknown }
  return typeof fields.provider === 'string'
    && typeof fields.model === 'string'
    && typeof fields.configured === 'boolean'
}

/**
 * @param value - decoded frame.
 * @returns whether it is one complete activity answer.
 */
export function isHostActivityAnswer(value: unknown): value is HostActivityAnswer {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown; activity?: unknown }
  if (frame.type !== 'host-activity-result' || typeof frame.id !== 'number' || !Number.isInteger(frame.id)) return false
  const activity = frame.activity
  if (typeof activity !== 'object' || activity === null) return false
  const counts = activity as { runningTurns?: unknown; packageOperations?: unknown; runningTerminals?: unknown }
  return [counts.runningTurns, counts.packageOperations, counts.runningTerminals]
    .every(count => typeof count === 'number' && Number.isInteger(count) && count >= 0)
}

/**
 * @param value - decoded frame.
 * @returns whether it is one maintenance-stop request.
 */
export function isHostShutdownRequest(value: unknown): value is HostShutdownRequest {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown }
  return frame.type === 'host-shutdown' && typeof frame.id === 'number' && Number.isInteger(frame.id)
}

/**
 * @param value - decoded frame.
 * @returns whether it is one complete maintenance-stop answer.
 */
export function isHostShutdownAnswer(value: unknown): value is HostShutdownAnswer {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; id?: unknown; ok?: unknown; error?: unknown }
  return frame.type === 'host-shutdown-result'
    && typeof frame.id === 'number'
    && Number.isInteger(frame.id)
    && typeof frame.ok === 'boolean'
    && (frame.error === undefined || typeof frame.error === 'string')
}

/**
 * @param value - decoded frame.
 * @returns whether it is one maintenance notice.
 */
export function isHostMaintenanceNotice(value: unknown): value is HostMaintenanceNotice {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; active?: unknown; reason?: unknown }
  return frame.type === 'host-maintenance'
    && typeof frame.active === 'boolean'
    && (frame.reason === undefined || typeof frame.reason === 'string')
}

/**
 * @param value - candidate label.
 * @returns the label when it is a non-empty bounded string.
 */
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_LENGTH ? value : undefined
}

/**
 * @param value - candidate configuration fingerprint.
 * @returns the fingerprint when it is a non-empty bounded string.
 */
function fingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FINGERPRINT_LENGTH ? value : undefined
}
