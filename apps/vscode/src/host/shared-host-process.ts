/**
 * Extension side of starting and attaching to the shared host.
 *
 * The window that wins the spawn lock starts `lib/companion.cjs` in serve mode
 * as a detached process, so closing that window does not stop the host other
 * windows use. Every window then attaches through {@link attachSharedHost}.
 *
 * @module @deepseek-ai/dsh-vscode/host/shared-host-process
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { resolveNodeExecutable } from './companion-bridge.ts'
import { SharedHostBridge, type SharedHostBridgeOptions } from './shared-bridge.ts'
import type { BridgeLimits } from '../shared/limits.ts'
import type { HostModelConfig } from '../shared/host-protocol.ts'

/** Inputs for one shared-host start. */
export interface StartSharedHostOptions {
  /** Extension root that carries `lib/companion.cjs` and the shipped overlay. */
  readonly extensionPath: string
  /** Extension storage directory: profile, home, connections, and token live below it. */
  readonly storageDir: string
  /** Launch directory this window generated its overlays in. */
  readonly launchDir: string
  /** Shipped overlay patch path. */
  readonly overlayPath: string
  /** Built Web frontend directory. */
  readonly shellRoot: string
  /** Working directory for the application. */
  readonly cwd: string
  /** Existing VS Code folder DSH registers as its initial Workspace. */
  readonly workspacePath?: string
  /** Configured DSH installation. */
  readonly runtimePath?: string
  /** Additional overlay patches applied above the shipped one. */
  readonly extraOverlays?: readonly string[]
  /** Extra environment for the application (credentials and endpoint). */
  readonly env?: Record<string, string>
  /** Configured Node executable. */
  readonly nodePath?: string
  /** Endpoint the host must listen on. */
  readonly endpoint: string
  /** Credential the host must require. */
  readonly token: string
  /** Root directory holding each window connection's resources. */
  readonly connectionsDir: string
  /** Deployment settings fingerprint the host reports to every window. */
  readonly configFingerprint: string
  /** Deployment model configuration every window displays; the host answers with it. */
  readonly modelConfig?: HostModelConfig
  /** Grace period after the last window leaves, in milliseconds. */
  readonly idleExitMs?: number
  /** Bounded-transfer budgets; the host's default applies when omitted. */
  readonly limits?: BridgeLimits
  /** Diagnostic sink. */
  readonly log: (line: string) => void
  /** How long to wait for the endpoint before reporting a failed start. */
  readonly startTimeoutMs?: number
}

/** One started shared-host process. */
export interface StartedSharedHost {
  /** Process id, when the operating system assigned one. */
  readonly pid: number | undefined
}

/**
 * Start the shared host as a detached process and wait until it listens.
 *
 * The child is unref'd and its standard streams are ignored: it outlives the
 * window that started it, and its diagnostics belong in the storage's log, not
 * in a pipe no window reads. A child that exits before listening is reported as
 * a failed start rather than waiting out the deadline.
 * @param options - application paths, endpoint, credential, and policy.
 * @returns the started process.
 * @throws when the executable cannot be found or the child exits before listening.
 */
export async function startSharedHostProcess(options: StartSharedHostOptions): Promise<StartedSharedHost> {
  const executable = resolveNodeExecutable(options.log, options.nodePath)
  const script = join(options.extensionPath, 'lib', 'companion.cjs')
  // The host outlives this window and has no parent reading a pipe, so its
  // diagnostics append to a storage log a later failure report can point at.
  const logPath = join(options.storageDir, 'runtime', 'host.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const logFile = openSync(logPath, 'a')
  const child = spawn(executable, [script, JSON.stringify({
    extensionPath: options.extensionPath,
    storageDir: options.storageDir,
    launchDir: options.launchDir,
    overlayPath: options.overlayPath,
    shellRoot: options.shellRoot,
    cwd: options.cwd,
    ...options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath },
    ...options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath },
    ...options.extraOverlays === undefined ? {} : { extraOverlays: options.extraOverlays },
    ...options.limits === undefined ? {} : { limits: options.limits },
    ...options.modelConfig === undefined ? {} : { modelConfig: options.modelConfig },
    serve: {
      endpoint: options.endpoint,
      token: options.token,
      connectionsDir: options.connectionsDir,
      configFingerprint: options.configFingerprint,
      ...options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs },
    },
  })], {
    stdio: ['ignore', logFile, logFile],
    windowsHide: true,
    cwd: options.cwd,
    detached: true,
    // The host owns the same isolated Harness home the per-window companion
    // used, whatever the extension host environment carries.
    env: { ...process.env, ...options.env, DSH_HOME: join(options.storageDir, 'home') },
  })
  // The child keeps its inherited copies; this process needs none.
  closeSync(logFile)
  child.unref()
  options.log(`dsh: started shared companion host (pid ${String(child.pid)}), logging to ${logPath}`)
  await waitForEndpoint(child, options, logPath)
  return { pid: child.pid }
}

/**
 * Attach this window to a running shared host.
 * @param options - endpoint, credential, identity, limits, and sinks.
 * @returns the attached window bridge.
 */
export async function attachSharedHost(options: SharedHostBridgeOptions): Promise<SharedHostBridge> {
  return await SharedHostBridge.start(options)
}

/**
 * Wait until the child listens on the endpoint.
 * @param child - the spawned host.
 * @param options - endpoint and deadline.
 * @param logPath - host log the failure report names.
 */
async function waitForEndpoint(
  child: ReturnType<typeof spawn>,
  options: StartSharedHostOptions,
  logPath: string,
): Promise<void> {
  const timeoutMs = options.startTimeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `dsh: the shared DSH host exited during startup (code ${String(child.exitCode)}, signal ${String(child.signalCode)}); see ${logPath}`,
      )
    }
    if (await reachable(options.endpoint)) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
  }
  child.kill()
  throw new Error(`dsh: the shared DSH host did not listen on ${options.endpoint} within ${String(timeoutMs)} ms; see ${logPath}`)
}

/**
 * @param endpoint - named pipe or socket path.
 * @returns whether one connection attempt succeeds.
 */
async function reachable(endpoint: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(endpoint)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}
