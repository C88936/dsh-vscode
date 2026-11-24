/**
 * Verify the extension-side shared-host path against a real companion process:
 * spawn the host, attach a window over the published endpoint, read the boot
 * payload and host activity, then release the window and stop the host.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostToken, resolveHostEndpoint } from '../src/shared/host-endpoint.ts'
import { attachSharedHost, startSharedHostProcess } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH ?? join(import.meta.dirname, '..')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-shared-attach-'))
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const log = (line) => process.stderr.write(`${line}\n`)
const failures = []

function check(condition, label) {
  process.stdout.write(`${label}: ${String(condition)}\n`)
  if (!condition) failures.push(label)
}

/** Options shared by every host start in this smoke. */
const hostOptions = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot: existsSync(join(extensionPath, 'dist', 'index.html')) ? join(extensionPath, 'dist') : join(extensionPath, '..', 'web', 'dist'),
  cwd: extensionPath,
  workspacePath: extensionPath,
  endpoint: endpoint.endpoint,
  token,
  connectionsDir: join(storageDir, 'connections'),
  configFingerprint: 'attach-smoke',
  idleExitMs: 1_500,
  limits: DEFAULT_BRIDGE_LIMITS,
  log,
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

/** Pids started by this smoke, ended during cleanup. */
const pids = []
const started = await startSharedHostProcess(hostOptions)
if (started.pid !== undefined) pids.push(started.pid)

const frames = []
const bridge = await attachSharedHost({
  endpoint: endpoint.endpoint,
  token,
  clientId: 'attach-smoke-window',
  extensionVersion: '0.0.0-smoke',
  configFingerprint: 'attach-smoke',
  limits: DEFAULT_BRIDGE_LIMITS,
  workspacePath: extensionPath,
  webview: {
    asUri: path => `uri:${path}`,
    postMessage: async (frame) => { frames.push(frame) },
  },
  log,
})

try {
  const payload = await bridge.prepare('/unused')
  check(payload.assets !== undefined && typeof payload.shell === 'string', 'boot payload carries the shell and bundles')
  check(payload.shell.startsWith('uri:'), 'boot payload paths are mapped to the window URIs')
  check(Object.keys(payload.assets).length > 0, 'bundles were materialized for this connection')
  check(existsSync(join(storageDir, 'connections', 'connection-1')), 'the connection got its own resource directory')
  const activity = await bridge.activity(10_000)
  check(Number.isInteger(activity.runningTurns), 'the host answered a host-wide activity query')
  await bridge.dispose()
  await new Promise(resolve => { setTimeout(resolve, 3_000) })
  let stillServing = true
  try {
    await attachSharedHost({
      endpoint: endpoint.endpoint,
      token,
      clientId: 'attach-smoke-late',
      extensionVersion: '0.0.0-smoke',
      configFingerprint: 'attach-smoke',
      limits: DEFAULT_BRIDGE_LIMITS,
      webview: { asUri: path => path, postMessage: async () => true },
      log,
    })
  } catch {
    stillServing = false
  }
  check(stillServing === false, 'the host exited on its own after the last window left')

  // The same recovery path the page uses after a maintenance restart: a window
  // starts a new host and attaches to it.
  const restarted = await startSharedHostProcess(hostOptions)
  if (restarted.pid !== undefined) pids.push(restarted.pid)
  const recovered = await attachSharedHost({
    endpoint: endpoint.endpoint,
    token,
    clientId: 'attach-smoke-recovered',
    extensionVersion: '0.0.0-smoke',
    configFingerprint: 'attach-smoke',
    limits: DEFAULT_BRIDGE_LIMITS,
    webview: { asUri: path => `uri:${path}`, postMessage: async () => true },
    log,
  })
  const recoveredPayload = await recovered.prepare('/unused')
  check(recoveredPayload.shell.startsWith('uri:'), 'a new host serves the reconnecting window')
  await recovered.dispose()
} catch (error) {
  process.stderr.write(`shared host attach smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // The idle exit already ended the process.
    }
  }
  try {
    rmSync(storageDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup of the smoke storage.
  }
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS extension-side shared host attach and recovery\n')
  }
}

