/**
 * Per-connection transport sessions inside the shared DSH host.
 *
 * The host boots DSH once. Every VS Code window that connects gets its own
 * `WebviewBridge`, its own peer scope, and its own resource directory, so
 * request ids, uploads, streams, page injections, and materialized bundles stay
 * scoped to that window while Sessions and execution state remain shared.
 *
 * @module @deepseek-ai/dsh-vscode/companion/session
 */
import { rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope, Principal } from '@deepseek-ai/dsh-client-connection'
import { WebviewBridge } from '../host/bridge.ts'
import { WorkspaceRegistration } from '../host/workspace-registration.ts'
import type { BridgeLimits } from '../shared/limits.ts'
import type { HostConnection, HostSession } from './server.ts'
import type { HostHello } from '../shared/host-protocol.ts'

/** Connection service surface the session factory reads. */
interface PeerFactory {
  createPeer(options: { readonly principal: Principal }): PeerScope
}

/** Inputs shared by every connection of one host. */
export interface SharedSessionOptions {
  /** Live DSH root context the host booted. */
  readonly ctx: Context
  /** Built Web frontend directory, materialized per connection. */
  readonly shellRoot: string
  /** Root directory holding one subdirectory per connection. */
  readonly connectionsDir: string
  /** Bounded-transfer budgets every window's Webview enforces. */
  readonly limits: BridgeLimits
  /** Diagnostic sink. */
  readonly log: (line: string) => void
}

/** Builds one connection's transport session. */
export type SharedSessionFactory = (hello: HostHello, connection: HostConnection) => Promise<HostSession>

/**
 * Create the factory the shared host calls for every admitted window.
 * @param options - application context, shell, resource root, limits, and log.
 * @returns a factory that prepares one bridge per connection.
 */
export function createSharedSessionFactory(options: SharedSessionOptions): SharedSessionFactory {
  const ctx = options.ctx
  const workspaces = new WorkspaceRegistration(ctx, options.log)
  return async (hello: HostHello, connection: HostConnection): Promise<HostSession> => {
    if (hello.workspacePath !== undefined) await workspaces.ensure(hello.workspacePath)
    const peers = ctx.get('connection') as PeerFactory | undefined
    if (peers === undefined) throw new Error('dsh: ctx.connection is unavailable')
    const peer = peers.createPeer({ principal: { kind: 'owner' } })
    const directory = join(options.connectionsDir, connection.id)
    const bridge = new WebviewBridge(
      ctx,
      directory,
      {
        asUri: path => path,
        postMessage: async (frame) => { connection.send(frame) },
      },
      options.log,
      options.limits,
      { peer, resourceDir: join(directory, 'webview') },
    )
    try {
      const ready = await bridge.prepare(options.shellRoot)
      options.log(`dsh host: prepared ${connection.id} for window ${hello.clientId}`)
      return {
        ready,
        handle: async (frame: unknown) => { await bridge.handle(frame) },
        dispose: async () => {
          bridge.dispose()
          removeConnectionDirectory(options.connectionsDir, directory, options.log)
          await peer.dispose()
        },
      }
    } catch (error) {
      // A connection that never became ready must not leave files or a peer
      // behind; the host reports the failure and refuses the window.
      bridge.dispose()
      removeConnectionDirectory(options.connectionsDir, directory, options.log)
      try {
        await peer.dispose()
      } catch (disposeError) {
        options.log(`dsh host: disposing ${connection.id} after a failed prepare failed: ${describe(disposeError)}`)
      }
      throw error
    }
  }
}

/**
 * Remove one connection's resource directory.
 *
 * Only a directory exactly one level below this host's connection root is
 * removed, so cleanup cannot follow a malformed connection id outside the root.
 * @param connectionsDir - root directory of every connection.
 * @param directory - the connection directory to remove.
 * @param log - diagnostic sink.
 */
function removeConnectionDirectory(
  connectionsDir: string,
  directory: string,
  log: (line: string) => void,
): void {
  const relativePath = relative(connectionsDir, directory)
  const segments = relativePath.split(sep).filter(segment => segment !== '')
  if (isAbsolute(relativePath) || segments.length !== 1 || segments[0] === '..') {
    log(`dsh host: kept connection files in an unexpected directory ${directory}`)
    return
  }
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    log(`dsh host: could not remove ${directory}: ${describe(error)}`)
  }
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
