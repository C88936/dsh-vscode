/**
 * Companion reply forwarding: the four replies WebviewBridge produces for the
 * upload carrier, uplink acknowledgement, lazy assets, and completion, plus the
 * transport reset a gone companion reports.
 *
 * These tests start the real CompanionBridge, so a reply counts only after it
 * crossed the child's stdout line protocol and the extension's dispatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CompanionBridge } from '../src/host/companion-bridge.ts'

interface Frame {
  readonly type: string
  readonly id?: number
  readonly seq?: number
  readonly status?: number
  readonly body?: string
  readonly uri?: string
  readonly assets?: Record<string, string>
  readonly error?: string | { readonly code: string; readonly message: string }
  readonly reason?: string
  readonly deliberate?: boolean
}

/** Root for the fake companion installations this suite writes. */
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * Write a fake companion that emits the given frames after its handshake.
 * @param lines - extra stdout lines the companion writes after `ready`.
 * @param exitAfter - exit with this code immediately after writing the lines.
 * @param lateLine - one expression the companion sends when it receives `shutdown`, before exiting.
 * @returns the installation root that serves as the extension path.
 */
function fakeCompanion(
  lines: readonly string[],
  exitAfter?: number,
  lateLine?: string,
  activity?: { readonly runningTurns: number; readonly packageOperations: number; readonly runningTerminals: number } | 'silent',
): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-companion-response-'))
  roots.push(root)
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'companion.cjs'), [
    "const options = JSON.parse(process.argv[2])",
    "const send = frame => process.stdout.write(`${JSON.stringify(frame)}\\n`)",
    "send({ type: 'ready', payload: { injections: [], assets: { '/bundle.js': `${options.extensionPath}/bundle.js` }, shell: `${options.extensionPath}/shell.js`, styles: [], limits: options.limits } })",
    ...lines.map(line => `send(${line})`),
    ...exitAfter === undefined
      ? [
        "process.stdin.on('data', chunk => {",
        "  const text = chunk.toString()",
        ...activity === undefined || activity === 'silent'
          ? []
          : [
            "  if (text.includes('activity-query')) {",
            "    const frame = JSON.parse(text)",
            `    send({ type: 'activity-result', id: frame.id, activity: ${JSON.stringify(activity)} })`,
            '  }',
          ],
        "  if (!text.includes('shutdown')) return",
        ...lateLine === undefined ? [] : [`  send(${lateLine})`],
        '  process.exit(0)',
        '})',
      ]
      : [`setImmediate(() => { process.exit(${String(exitAfter)}) })`],
    '',
  ].join('\n'))
  return root
}

/** Host surface that records every frame and names pseudo webview URIs. */
function recorder(): { frames: Frame[]; webview: { asUri(path: string): string; postMessage(message: unknown): Promise<boolean> } } {
  const frames: Frame[] = []
  return {
    frames,
    webview: {
      asUri: path => `vscode-webview://test/${path.replaceAll('\\', '/')}`,
      postMessage: async (message) => {
        frames.push(message as Frame)
        return true
      },
    },
  }
}

async function waitFor(frames: readonly Frame[], predicate: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const frame = frames.find(predicate)
    if (frame !== undefined) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for a frame; received ${JSON.stringify(frames)}`)
}

describe('CompanionBridge reply forwarding', () => {
  it('forwards the four companion replies with their fields and webview URIs', async () => {
    const root = fakeCompanion([
      "{ type: 'asset-result', id: 3, uri: `${options.extensionPath}/icon.png`, assets: { 'plugins/demo/assets/icon-abc.png': `${options.extensionPath}/icon.png` } }",
      "{ type: 'upload-ack', id: 4, seq: 7 }",
      "{ type: 'upload-result', id: 4, status: 200, body: '{\"ok\":true}' }",
      "{ type: 'stream-uplink-ack', id: 5, seq: 2 }",
      "{ type: 'asset-result', id: 6, error: 'the package does not export that file' }",
      "{ type: 'not-a-frame', id: 7 }",
      "process.stdout.write('not json\\n')",
    ])
    const { frames, webview } = recorder()
    const logs: string[] = []
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      log: line => { logs.push(line) },
    }, webview)
    try {
      const asset = await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 3)
      expect(asset.uri).toBe(`vscode-webview://test/${root.replaceAll('\\', '/')}/icon.png`)
      expect(asset.assets).toEqual({
        'plugins/demo/assets/icon-abc.png': `vscode-webview://test/${root.replaceAll('\\', '/')}/icon.png`,
      })
      expect(await waitFor(frames, frame => frame.type === 'upload-ack' && frame.id === 4)).toMatchObject({ seq: 7 })
      expect(await waitFor(frames, frame => frame.type === 'upload-result' && frame.id === 4))
        .toMatchObject({ status: 200, body: '{"ok":true}' })
      expect(await waitFor(frames, frame => frame.type === 'stream-uplink-ack' && frame.id === 5)).toMatchObject({ seq: 2 })
      expect(await waitFor(frames, frame => frame.type === 'asset-result' && frame.id === 6))
        .toMatchObject({ error: 'the package does not export that file' })
      // The unreadable lines are reported, and neither becomes a Webview frame.
      expect(logs.some(line => line.includes('unreadable companion frame'))).toBe(true)
      expect(logs.some(line => line.includes('not a known message'))).toBe(true)
      expect(frames.some(frame => frame.type === 'not-a-frame')).toBe(false)
    } finally {
      await bridge.dispose()
    }
  })

  it('settles the Webview transport when the companion exits unexpectedly', async () => {
    const root = fakeCompanion([], 3)
    const { frames, webview } = recorder()
    const exits: { code: number | null }[] = []
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      onExit: exit => { exits.push({ code: exit.code }) },
      log: () => {},
    }, webview)
    const reset = await waitFor(frames, frame => frame.type === 'transport-reset')
    expect(reset.reason).toContain('exited')
    await waitFor(frames, frame => frame.type === 'transport-reset')
    for (let attempt = 0; attempt < 100 && exits.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(exits).toEqual([{ code: 3 }])
    await bridge.dispose()
    // The process already exited, so the stop has nothing left to notify: the
    // page settles once, from the unexpected exit.
    expect(frames.filter(frame => frame.type === 'transport-reset')).toHaveLength(1)
  })

  it('settles the page when the extension stops a live companion', async () => {
    const root = fakeCompanion([])
    const { frames, webview } = recorder()
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      log: () => {},
    }, webview)
    await bridge.dispose()
    // The stop is the extension's own restart, not a crash: the page settles
    // its waits and resolves an in-flight restart request instead of reporting
    // a failure it cannot act on.
    const resets = frames.filter(frame => frame.type === 'transport-reset')
    expect(resets).toHaveLength(1)
    expect(resets[0]).toMatchObject({ deliberate: true })
    expect(resets[0]?.reason).toContain('stopped')
  })

  it('answers an activity query with the work it is running', async () => {
    const root = fakeCompanion([], undefined, undefined, { runningTurns: 2, packageOperations: 1, runningTerminals: 3 })
    const { webview } = recorder()
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      log: () => {},
    }, webview)
    try {
      await expect(bridge.activity()).resolves.toEqual({ runningTurns: 2, packageOperations: 1, runningTerminals: 3 })
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects an activity query the companion does not answer', async () => {
    const root = fakeCompanion([], undefined, undefined, 'silent')
    const { webview } = recorder()
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      log: () => {},
    }, webview)
    try {
      // An unanswered query means the work is unknown; it must not read as an idle companion.
      await expect(bridge.activity(50)).rejects.toThrow(/did not answer/u)
    } finally {
      await bridge.dispose()
    }
  })

  it('drops a frame an old generation sent while stopping', async () => {
    const root = fakeCompanion([], undefined, "{ type: 'upload-ack', id: 99, seq: 1 }")
    const { frames, webview } = recorder()
    const bridge = await CompanionBridge.start({
      extensionPath: root,
      storageDir: join(root, 'storage'),
      launchDir: join(root, 'launch'),
      overlayPath: join(root, 'overlay.yml'),
      shellRoot: join(root, 'shell'),
      cwd: root,
      nodePath: process.execPath,
      log: () => {},
    }, webview)
    await bridge.dispose()
    // The next page starts its ids over, so the stopping generation's late
    // answer must not resolve one of them.
    expect(frames.some(frame => frame.type === 'upload-ack')).toBe(false)
  })
})
