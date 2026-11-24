/**
 * Drive the shared host mode without VS Code: one companion process serves two
 * clients over a real local endpoint, keeps serving after one leaves, and exits
 * on its own once the last window is gone.
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionPath = process.env.DSH_VSCODE_EXTENSION_PATH === undefined
  ? join(here, '..')
  : resolve(process.env.DSH_VSCODE_EXTENSION_PATH)
const packagedShell = join(extensionPath, 'dist')
const shellRoot = existsSync(join(packagedShell, 'index.html'))
  ? packagedShell
  : join(extensionPath, '..', '..', 'apps', 'web', 'dist')
const script = join(extensionPath, 'lib', 'companion.cjs')
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-shared-'))
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\dsh-vscode-smoke-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  : join(storageDir, 'host.sock')
const token = randomBytes(32).toString('hex')
const connectionsDir = join(storageDir, 'connections')
const options = {
  extensionPath,
  storageDir,
  launchDir: join(storageDir, 'launch', 'smoke'),
  overlayPath: join(extensionPath, 'profile', 'vscode.patch.yml'),
  shellRoot,
  cwd: extensionPath,
  workspacePath: extensionPath,
  serve: {
    endpoint,
    token,
    connectionsDir,
    configFingerprint: 'shared-host-smoke',
    idleExitMs: 1_500,
  },
  ...process.env.DSH_VSCODE_RUNTIME === undefined ? {} : { runtimePath: process.env.DSH_VSCODE_RUNTIME },
}

const failures = []
function check(condition, label) {
  process.stdout.write(`${label}: ${String(condition)}\n`)
  if (!condition) failures.push(label)
}

const node = process.env.DSH_VSCODE_NODE ?? process.execPath
const child = spawn(node, [script, JSON.stringify(options)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: join(storageDir, 'home') },
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.stdout.on('data', chunk => process.stderr.write(chunk))

const exited = new Promise(resolve => child.once('exit', (code, signal) => { resolve({ code, signal }) }))

/**
 * @param {string} endpointName - pipe or socket to connect.
 * @returns {Promise<import('node:net').Socket>} one connected socket.
 */
async function connectOnce(endpointName) {
  const socket = connect(endpointName)
  await new Promise((resolvePromise, reject) => {
    socket.once('connect', resolvePromise)
    socket.once('error', reject)
  })
  return socket
}

/**
 * @param {string} endpointName - pipe or socket to reach.
 * @returns {Promise<import('node:net').Socket>} the first successful connection.
 */
async function connectWithRetry(endpointName) {
  const deadline = Date.now() + 120_000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await connectOnce(endpointName)
    } catch (error) {
      lastError = error
      await new Promise(resolvePromise => { setTimeout(resolvePromise, 200) })
    }
  }
  throw new Error(`the shared host never listened on ${endpointName}: ${String(lastError)}`)
}

/** One window connection speaking the newline-JSON frame protocol. */
class Client {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.frames = []
    this.waiters = new Set()
    socket.on('data', chunk => { this.receive(chunk.toString('utf8')) })
    socket.on('error', () => {})
  }

  receive(text) {
    this.buffer += text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      this.frames.push(frame)
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(frame)) continue
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  }

  send(frame) {
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  async next(predicate, label, timeoutMs = 30_000) {
    const existing = this.frames.find(predicate)
    if (existing !== undefined) return existing
    return await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`timed out waiting for ${label}`))
      }, timeoutMs)
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  close() {
    this.socket.destroy()
  }
}

/**
 * @param {string} clientId - window identity. @param {number} protocol - spoken version.
 * @returns {object} one hello frame.
 */
function hello(clientId, protocol = 1) {
  return {
    type: 'hello',
    protocol,
    token,
    clientId,
    extensionVersion: '0.0.0-smoke',
    workspacePath: extensionPath,
    configFingerprint: 'shared-host-smoke',
    limits: {
      unaryBodyBytes: 8 * 1024 * 1024,
      packageAssetCount: 256,
      packageAssetBytes: 2 * 1024 * 1024,
      packageAssetTotalBytes: 32 * 1024 * 1024,
      binaryResponseBytes: 5 * 1024 * 1024,
    },
  }
}

/**
 * @param {string} clientId - window identity.
 * @returns {Promise<Client>} one admitted client.
 */
async function openClient(clientId) {
  const socket = await connectWithRetry(endpoint)
  const client = new Client(socket)
  client.send(hello(clientId))
  await client.next(frame => frame.type === 'hello-ok', `${clientId} hello-ok`)
  return client
}

try {
  const first = await openClient('window-a')
  const second = await openClient('window-b')
  const firstHello = first.frames.find(frame => frame.type === 'hello-ok')
  const secondHello = second.frames.find(frame => frame.type === 'hello-ok')
  const firstReady = await first.next(frame => frame.type === 'ready', 'window-a ready')
  const secondReady = await second.next(frame => frame.type === 'ready', 'window-b ready')
  check(firstHello.connectionId !== secondHello.connectionId, 'windows have distinct connection ids')
  check(firstHello.instanceId === secondHello.instanceId, 'both windows reached the same host instance')
  check(typeof firstReady.payload?.shell === 'string', 'window-a received the shell entry')
  check(typeof secondReady.payload?.shell === 'string', 'window-b received the shell entry')
  check(Object.keys(firstReady.payload?.assets ?? {}).length > 0, 'window-a received materialized bundles')
  check(firstReady.payload.shell === secondReady.payload.shell, 'both windows share the same shell')

  first.send({ type: 'fetch', id: 1, url: '/api/shared-host-smoke-unknown' })
  const firstAnswer = await first.next(frame => frame.type === 'fetch-result' && frame.id === 1, 'window-a fetch answer')
  check(Number.isInteger(firstAnswer.status), 'window-a received an HTTP status from the shared host')

  second.send({ type: 'fetch', id: 2, url: '/api/shared-host-smoke-unknown' })
  const secondAnswer = await second.next(frame => frame.type === 'fetch-result' && frame.id === 2, 'window-b fetch answer')
  check(Number.isInteger(secondAnswer.status), 'window-b received its own answer with the same request id')

  second.send({ type: 'stream-open', id: 3, endpoint: 'smoke/absent', payload: {} })
  const streamEnd = await second.next(frame => frame.type === 'stream-end' && frame.id === 3, 'window-b stream result')
  check(streamEnd.error !== undefined, 'an unknown stream endpoint is reported to the requesting window')

  first.close()
  await new Promise(resolvePromise => { setTimeout(resolvePromise, 500) })
  second.send({ type: 'fetch', id: 4, url: '/api/shared-host-smoke-unknown' })
  const afterClose = await second.next(frame => frame.type === 'fetch-result' && frame.id === 4, 'window-b answer after window-a left')
  check(Number.isInteger(afterClose.status), 'the surviving window keeps using the host after the other window closed')

  second.send({ type: 'host-shutdown', id: 5 })
  const shutdown = await second.next(
    frame => frame.type === 'host-shutdown-result' && frame.id === 5,
    'window-b shutdown answer',
    60_000,
  )
  check(shutdown.ok === true, 'the host accepted the maintenance stop')

  const outcome = await Promise.race([
    exited,
    new Promise(resolvePromise => { setTimeout(() => { resolvePromise({ timeout: true }) }, 30_000) }),
  ])
  check(outcome.timeout !== true && outcome.code === 0, `the host exited after the requested stop (${JSON.stringify(outcome)})`)
} catch (error) {
  process.stderr.write(`shared host smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  failures.push('exception')
} finally {
  child.kill()
  try {
    rmSync(storageDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup of the smoke storage.
  }
  if (failures.length > 0) {
    process.stdout.write(`FAIL ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('PASS shared host serves two windows and stops on request\n')
  }
}
