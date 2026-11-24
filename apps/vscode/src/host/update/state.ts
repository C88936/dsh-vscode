/**
 * The update flow as one explicit state machine.
 *
 * Every step the extension takes is a transition this module admits or refuses, so a download cannot start before a
 * check found an update, and an install cannot start before a verified file exists. A state carries the version it is
 * working on and, after a failure, the reason that stopped the flow; there is no second copy of either fact elsewhere.
 * @module @deepseek-ai/dsh-vscode/host/update/state
 */
import type { UpdateManifest } from './manifest.ts'

/** Name of one update state. */
export type UpdateStateName = 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'installing' | 'failed'

/** No update flow is running. */
export interface IdleUpdateState {
  /** Discriminant. */
  readonly name: 'idle'
}

/** A feed request is in flight. */
export interface CheckingUpdateState {
  /** Discriminant. */
  readonly name: 'checking'
}

/** A feed found an update that has not been downloaded. */
export interface AvailableUpdateState {
  /** Discriminant. */
  readonly name: 'available'
  /** The applicable feed. */
  readonly manifest: UpdateManifest
  /** Version the feed publishes. */
  readonly version: string
}

/** The verified file is being downloaded. */
export interface DownloadingUpdateState {
  /** Discriminant. */
  readonly name: 'downloading'
  /** The applicable feed. */
  readonly manifest: UpdateManifest
  /** Version being downloaded. */
  readonly version: string
}

/** A verified file is ready to install. */
export interface StagedUpdateState {
  /** Discriminant. */
  readonly name: 'staged'
  /** The applicable feed. */
  readonly manifest: UpdateManifest
  /** Version of the verified file. */
  readonly version: string
  /** Absolute path of the verified file. */
  readonly path: string
  /** Measured SHA-256 of the verified file. */
  readonly sha256: string
}

/** VS Code is installing the verified file and reloading the window. */
export interface InstallingUpdateState {
  /** Discriminant. */
  readonly name: 'installing'
  /** The applicable feed. */
  readonly manifest: UpdateManifest
  /** Version being installed. */
  readonly version: string
  /** Absolute path of the verified file. */
  readonly path: string
  /** Measured SHA-256 of the verified file. */
  readonly sha256: string
}

/** The last attempt stopped; the reason survives until the next attempt resets the flow. */
export interface FailedUpdateState {
  /** Discriminant. */
  readonly name: 'failed'
  /** Version the failed attempt was working on, or undefined when none was known. */
  readonly version: string | undefined
  /** Why the attempt stopped, as a line an operator can act on. */
  readonly reason: string
}

/** One update state. */
export type UpdateState =
  | IdleUpdateState
  | CheckingUpdateState
  | AvailableUpdateState
  | DownloadingUpdateState
  | StagedUpdateState
  | InstallingUpdateState
  | FailedUpdateState

/** One event the update flow can process. */
export type UpdateStateEvent =
  | { readonly type: 'check-started' }
  | { readonly type: 'update-available'; readonly manifest: UpdateManifest }
  | { readonly type: 'no-update' }
  | { readonly type: 'download-started' }
  | { readonly type: 'download-staged'; readonly path: string; readonly sha256: string }
  | { readonly type: 'install-started' }
  | { readonly type: 'install-finished' }
  | { readonly type: 'install-refused' }
  | { readonly type: 'failed'; readonly reason: string }
  | { readonly type: 'reset' }

/** Result of one transition: the next state, or why the event does not apply. */
export type UpdateTransition =
  | { readonly ok: true; readonly state: UpdateState }
  | {
    readonly ok: false
    /** State the event arrived in. */
    readonly from: UpdateStateName
    /** Event that did not apply. */
    readonly event: UpdateStateEvent['type']
    /** Readable reason naming what the flow was doing instead. */
    readonly detail: string
  }

/**
 * Events each state accepts.
 *
 * `failed` is accepted everywhere so one attempt's failure cannot be dropped because another step already moved the
 * flow on; `reset` returns any state to `idle`.
 */
const ALLOWED_EVENTS: Readonly<Record<UpdateStateName, readonly UpdateStateEvent['type'][]>> = {
  idle: ['check-started', 'failed'],
  checking: ['update-available', 'no-update', 'failed'],
  available: ['check-started', 'download-started', 'failed', 'reset'],
  downloading: ['download-staged', 'failed'],
  staged: ['download-started', 'install-started', 'failed', 'reset'],
  installing: ['install-finished', 'install-refused', 'failed'],
  failed: ['check-started', 'failed', 'reset'],
}

/**
 * Apply one event to one state.
 * @param state - current state.
 * @param event - event to process.
 * @returns the next state, or the refused event with the state and event names.
 */
export function nextUpdateState(state: UpdateState, event: UpdateStateEvent): UpdateTransition {
  if (event.type === 'reset') return { ok: true, state: { name: 'idle' } }
  if (!ALLOWED_EVENTS[state.name].includes(event.type)) {
    return {
      ok: false,
      from: state.name,
      event: event.type,
      detail: `an update cannot process ${event.type} while it is ${state.name}`,
    }
  }
  switch (event.type) {
    case 'check-started':
      return { ok: true, state: { name: 'checking' } }
    case 'update-available':
      return {
        ok: true,
        state: { name: 'available', manifest: event.manifest, version: event.manifest.version },
      }
    case 'no-update':
      return { ok: true, state: { name: 'idle' } }
    case 'download-started':
      return 'manifest' in state
        ? { ok: true, state: { name: 'downloading', manifest: state.manifest, version: state.version } }
        : refuse(state, event)
    case 'download-staged':
      return state.name === 'downloading'
        ? {
          ok: true,
          state: {
            name: 'staged',
            manifest: state.manifest,
            version: state.version,
            path: event.path,
            sha256: event.sha256,
          },
        }
        : refuse(state, event)
    case 'install-started':
      return state.name === 'staged'
        ? {
          ok: true,
          state: {
            name: 'installing',
            manifest: state.manifest,
            version: state.version,
            path: state.path,
            sha256: state.sha256,
          },
        }
        : refuse(state, event)
    case 'install-finished':
      return { ok: true, state: { name: 'idle' } }
    case 'install-refused':
      // The install never started, so the verified file stays staged for the next attempt.
      return state.name === 'installing'
        ? {
          ok: true,
          state: {
            name: 'staged',
            manifest: state.manifest,
            version: state.version,
            path: state.path,
            sha256: state.sha256,
          },
        }
        : refuse(state, event)
    case 'failed':
      return {
        ok: true,
        state: { name: 'failed', version: 'version' in state ? state.version : undefined, reason: event.reason },
      }
  }
}

/**
 * @param state - current state. @param event - event whose payload the state lacks.
 * @returns the refused event.
 */
function refuse(state: UpdateState, event: UpdateStateEvent): UpdateTransition {
  return {
    ok: false,
    from: state.name,
    event: event.type,
    detail: `the ${state.name} state carries no update to apply ${event.type} to`,
  }
}

/**
 * Describe one state in one diagnostic line.
 * @param state - state to describe.
 * @returns the state name followed by the version and reason it carries.
 */
export function describeUpdateState(state: UpdateState): string {
  switch (state.name) {
    case 'idle':
    case 'checking':
      return state.name
    case 'failed':
      return state.version === undefined ? `failed: ${state.reason}` : `failed (${state.version}): ${state.reason}`
    default:
      return `${state.name} ${state.version}`
  }
}

/**
 * Owns the current update state for one activation.
 *
 * The owner is the instance, not a module-level value: two windows of one profile each run their own flow, and a
 * refusal never mutates the state it reported on.
 */
export class UpdateStateMachine {
  private current: UpdateState = { name: 'idle' }

  /** @param onChange - receives each accepted transition after the state is committed. */
  constructor(private readonly onChange?: (state: UpdateState) => void) {}

  /** @returns the current state. */
  get state(): UpdateState {
    return this.current
  }

  /**
   * @param event - event to process against the current state.
   * @returns the transition result; the state advances only when the event applies.
   */
  apply(event: UpdateStateEvent): UpdateTransition {
    const transition = nextUpdateState(this.current, event)
    if (transition.ok) {
      this.current = transition.state
      this.onChange?.(this.current)
    }
    return transition
  }
}
