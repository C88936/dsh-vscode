/**
 * Drive the companion host over its stdio protocol without VS Code.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH === undefined
  ? join(here, '..')
  : resolve(process.env.DSH_VSCODE_EXTENSION_PATH)
const packagedShell = join(extensionPath, 'dist')
const shellRoot = existsSync(join(packagedShell, 'index.html'))
  ? packagedShell
  : join(extensionPath, '..', '..', 'apps', 'web', 'dist')
const script = join(extensionPath, 'lib', 'companion.cjs')
const providedStorage = process.env.DSH_VSCODE_STORAGE
// The companion runs its sandbox rooted at this extension, so a storage
// directory under the system temp root makes Windows ACL preparation depend on
// a path outside the workspace. Keep the default inside the extension instead.
const storageDir = providedStorage === undefined
  ? join(extensionPath, '.tmp', 'companion-smoke')
  : resolve(providedStorage)
mkdirSync(storageDir, { recursive: true })
const options = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot,
  cwd: extensionPath,
  workspacePath: extensionPath,
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

const node = process.env.DSH_VSCODE_NODE ?? process.execPath
const child = spawn(node, [script, JSON.stringify(options)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: join(storageDir, 'home') },
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
const lines = createInterface({ input: child.stdout })
const childExit = new Promise(resolve => { child.on('exit', resolve) })

let ready
let failed = false
let workspaceBound = false
let workspaceProjected = false
let workspaceSessionVisible = false
let welcomeAcknowledged = false
const done = new Promise(resolve => {
  ready = resolve
})

lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'log') {
    process.stderr.write(`[companion] ${frame.line}\n`)
    if (frame.line.startsWith('dsh: workspace bound ')) workspaceBound = true
    return
  }
  if (frame.type === 'ready') {
    process.stdout.write(`ready: ${String(frame.payload.injections.length)} injections, ${String(Object.keys(frame.payload.assets).length)} assets\n`)
    process.stdout.write(`shell: ${frame.payload.shell}\n`)
    child.stdin.write(`${JSON.stringify({
      type: 'stream-open',
      id: 2,
      endpoint: 'workspace/follow',
      payload: { args: {} },
    })}\n`)
    return
  }
  if (frame.type === 'stream-item' && frame.id === 2) {
    if (frame.item?.type === 'baseline') {
      workspaceProjected = Array.isArray(frame.item.value?.items) && frame.item.value.items.length > 0
      workspaceSessionVisible = workspaceProjected
        && frame.item.value.items.some(workspace => Array.isArray(workspace.sessionIds) && workspace.sessionIds.length > 0)
      process.stdout.write(`workspace projected: ${String(workspaceProjected)}\n`)
      process.stdout.write(`workspace session visible: ${String(workspaceSessionVisible)}\n`)
      child.stdin.write(`${JSON.stringify({
        type: 'fetch',
        id: 9,
        url: 'api/settings/describe',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'settings-describe-smoke',
          method: 'settings/describe',
          payload: { args: {} },
        }),
      })}\n`)
    }
    return
  }
  if (frame.type === 'stream-end' && frame.id === 2) {
    process.stdout.write(`workspace stream ended: ${JSON.stringify(frame.error ?? null)}\n`)
    if (!workspaceProjected) {
      failed = true
      ready()
    }
    return
  }
  if (frame.type === 'fetch-result') {
    process.stdout.write(`rpc ${String(frame.id)}: ${String(frame.status)} ${String(frame.body).slice(0, 160)}\n`)
    if (frame.id === 9) {
      let revision
      try {
        const response = JSON.parse(frame.body)
        const settings = response?.result?.ok === true
          ? response.result.value.namespaces.find(namespace => namespace.ns === 'ui-settings-general')
          : undefined
        revision = settings?.revision
        welcomeAcknowledged = settings?.value?.welcomeNoticeVersion === '2026-09-28.1'
      } catch {
        revision = undefined
      }
      process.stdout.write(`settings revision: ${String(revision)}\n`)
      process.stdout.write(`welcome acknowledged: ${String(welcomeAcknowledged)}\n`)
      if (frame.status !== 200 || revision === undefined) {
        failed = true
        child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
        child.stdin.end()
        ready()
        return
      }
      child.stdin.write(`${JSON.stringify({
        type: 'fetch',
        id: 10,
        url: 'api/settings/mutate',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'settings-smoke',
          method: 'settings/mutate',
          payload: {
            args: {
              ns: 'ui-settings-general',
              ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-09-28.1' }],
              expectedRevision: revision,
            },
          },
        }),
      })}\n`)
      return
    }
    if (frame.id === 10) {
      let businessOk = false
      try {
        const response = JSON.parse(frame.body)
        businessOk = frame.status === 200 && response?.result?.ok === true
      } catch {
        businessOk = false
      }
      process.stdout.write(`settings mutate success: ${String(businessOk)}\n`)
      if (!businessOk) {
        failed = true
        child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
        child.stdin.end()
        ready()
        return
      }
      child.stdin.write(`${JSON.stringify({
        type: 'fetch',
        id: 1,
        url: 'api/session/list',
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'session/list', payload: { args: { _request: {} } } }),
      })}\n`)
      return
    }
    let businessOk = false
    let sessionVisible = false
    try {
      const response = JSON.parse(frame.body)
      businessOk = frame.status === 200 && response?.result?.ok === true
      sessionVisible = businessOk && Array.isArray(response.result.value?.items) && response.result.value.items.length > 0
    } catch {
      businessOk = false
    }
    process.stdout.write(`rpc business success: ${String(businessOk)}\n`)
    process.stdout.write(`session visible: ${String(sessionVisible)}\n`)
    failed = !businessOk || !sessionVisible
    child.stdin.write(`${JSON.stringify({ type: 'stream-cancel', id: 2 })}\n`)
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.stdin.end()
    ready()
    return
  }
  if (frame.type === 'fatal') {
    process.stdout.write(`fatal: ${frame.message}\n`)
    failed = true
    ready()
  }
})

const timeout = setTimeout(() => {
  process.stdout.write('timeout\n')
  failed = true
  child.kill()
  ready()
}, 120_000)
await done
clearTimeout(timeout)
const exitTimeout = setTimeout(() => {
  process.stdout.write('companion did not exit after shutdown\n')
  failed = true
  child.kill()
}, 10_000)
await childExit
clearTimeout(exitTimeout)
if (providedStorage === undefined) rmSync(storageDir, { recursive: true, force: true })
process.stdout.write(`workspace bound: ${String(workspaceBound)}\n`)
if (!workspaceBound) failed = true
if (!workspaceProjected) failed = true
if (!workspaceSessionVisible) failed = true
if (!welcomeAcknowledged) failed = true
if (failed) process.exitCode = 1
