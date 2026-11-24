/**
 * The update flow's orchestration: inert without a feed URL, one automatic check per interval, a manual check that
 * ignores the interval, and a download that must verify before the install runs.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateController, type UpdateControllerOptions } from '../src/host/update/controller.ts'

const FEED_URL = 'https://updates.lan/dsh/release-feed.json'
const VSIX_URL = 'https://updates.lan/dsh/dsh-vscode-0.2.0.vsix'
const VSIX = new TextEncoder().encode('the bytes of the published VSIX')

const directories: string[] = []

/** @returns a fresh update directory that the suite removes. */
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-vscode-controller-'))
  directories.push(directory)
  return directory
}

/**
 * @param overrides - feed fields the case changes.
 * @returns one feed document for version 0.2.0.
 */
function feedText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 'dsh-vscode-update/v1',
    extensionId: 'deepseek-ai.dsh-vscode',
    version: '0.2.0',
    engines: { vscode: '^1.96.0' },
    targetPlatform: 'win32-x64',
    url: VSIX_URL,
    sha256: createHash('sha256').update(VSIX).digest('hex'),
    size: VSIX.byteLength,
    publishedAt: '2026-11-19T12:00:00.000Z',
    ...overrides,
  })
}

/**
 * @param feed - feed document.
 * @param body - VSIX bytes the artifact address returns.
 * @param requested - receives every requested address, in order.
 * @returns a fetch double that serves only those two addresses.
 */
function transport(feed: string, body: Uint8Array, requested: string[] = []): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input)
    requested.push(url)
    if (url === FEED_URL) return await new Response(feed)
    if (url === VSIX_URL) return await new Response(body)
    throw new TypeError(`unexpected request to ${url}`)
  }
}

/**
 * @param overrides - fields the case changes.
 * @returns a controller for a 0.1.0 window on win32-x64.
 */
function controller(overrides: Partial<UpdateControllerOptions> = {}): UpdateController {
  return new UpdateController({
    extensionId: 'deepseek-ai.dsh-vscode',
    localVersion: '0.1.0',
    vscodeVersion: '1.96.0',
    targetPlatform: 'win32-x64',
    directory: join(workspace(), 'updates'),
    feedUrl: () => FEED_URL,
    checkIntervalMinutes: () => 0,
    download: async run => await run(new AbortController().signal),
    install: async () => ({ ok: true, version: '0.2.0' }),
    log: () => {},
    ...overrides,
  })
}

/** Let the scheduled check's promise chain settle. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('UpdateController', () => {
  it('discovers an update from a directory without requesting the VSIX until asked', async () => {
    const requested: string[] = []
    const states: string[] = []
    const updates = controller({
      feedUrl: () => 'https://updates.lan/dsh/',
      checkIntervalMinutes: () => 15,
      onStateChange: state => { states.push(state.name) },
      fetch: transport(feedText(), VSIX, requested),
    })

    await expect(updates.check('automatic')).resolves.toMatchObject({ status: 'available' })
    expect(requested).toEqual([FEED_URL])
    expect(states).toEqual(['checking', 'available'])

    await expect(updates.installAndReload()).resolves.toMatchObject({ status: 'installed' })
    expect(requested).toEqual([FEED_URL, VSIX_URL])
    expect(states).toEqual(['checking', 'available', 'downloading', 'staged', 'installing', 'idle'])
  })

  it('does not request a cleartext company directory', async () => {
    const requested: string[] = []
    const updates = controller({ feedUrl: () => 'http://updates.lan/dsh/', fetch: transport(feedText(), VSIX, requested) })

    await expect(updates.check('manual')).resolves.toMatchObject({ status: 'failed', reason: expect.stringContaining('only for a loopback test server') })
    expect(requested).toEqual([])
  })

  it('does nothing without a configured feed URL', async () => {
    const requested: string[] = []
    const updates = controller({ feedUrl: () => '', fetch: transport(feedText(), VSIX, requested) })

    await expect(updates.check('manual')).resolves.toMatchObject({ status: 'skipped' })
    await expect(updates.check('automatic')).resolves.toMatchObject({ status: 'skipped' })
    expect(requested).toEqual([])
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('keeps automatic checks off when the interval is 0', async () => {
    const requested: string[] = []
    const updates = controller({ fetch: transport(feedText(), VSIX, requested) })

    await expect(updates.check('automatic')).resolves.toMatchObject({
      status: 'skipped',
      reason: 'automatic update checks are disabled',
    })
    expect(requested).toEqual([])
  })

  it('logs a denied background feed without offering an update', async () => {
    const lines: string[] = []
    const states: string[] = []
    const updates = controller({
      checkIntervalMinutes: () => 60,
      fetch: async () => { throw new Error('EACCES: permission denied') },
      notifyAvailable: async () => { throw new Error('a denied feed must not offer an update') },
      onStateChange: state => { states.push(state.name) },
      log: line => { lines.push(line) },
    })

    const stop = updates.start()
    try {
      await flush()
      expect(states).toEqual(['checking', 'failed'])
      expect(lines).toEqual([expect.stringContaining('EACCES: permission denied')])
    } finally {
      stop()
    }
  })

  it('checks at most once per interval and lets a manual check through', async () => {
    const requested: string[] = []
    let at = 1_000_000
    const updates = controller({
      checkIntervalMinutes: () => 15,
      now: () => at,
      fetch: transport(feedText(), VSIX, requested),
    })

    await expect(updates.check('automatic')).resolves.toMatchObject({ status: 'available' })
    at += 60_000
    await expect(updates.check('automatic')).resolves.toMatchObject({
      status: 'skipped',
      reason: 'the previous automatic check was less than 15 minutes ago',
    })
    await expect(updates.check('manual')).resolves.toMatchObject({ status: 'available' })
    at += 14 * 60_000
    await expect(updates.check('automatic')).resolves.toMatchObject({ status: 'available' })
    expect(requested.filter(url => url === FEED_URL)).toHaveLength(3)
  })

  it('reports an update the feed applies and asks before installing it', async () => {
    const asked: string[] = []
    const installed: string[] = []
    const updates = controller({
      checkIntervalMinutes: () => 15,
      fetch: transport(feedText(), VSIX),
      notifyAvailable: async (update) => {
        asked.push(update.version)
        return false
      },
      install: async (staged) => {
        installed.push(staged.path)
        return { ok: true, version: staged.version }
      },
    })

    const outcome = await updates.check('automatic')

    expect(outcome).toMatchObject({ status: 'available', update: { version: '0.2.0' } })
    expect(asked).toEqual(['0.2.0'])
    expect(installed).toEqual([])
    expect(updates.state).toMatchObject({ name: 'available', version: '0.2.0' })
  })

  it('downloads, verifies, and installs when the user asks for it', async () => {
    const installed: string[] = []
    const updates = controller({
      checkIntervalMinutes: () => 15,
      fetch: transport(feedText(), VSIX),
      notifyAvailable: async () => true,
      install: async (staged) => {
        installed.push(staged.path)
        return { ok: true, version: staged.version }
      },
    })

    await updates.check('automatic')

    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatch(new RegExp(`dsh-vscode-0\\.2\\.0\\.vsix$`, 'u'))
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('reports the reason a feed does not apply and returns to idle', async () => {
    const updates = controller({
      localVersion: '0.2.0',
      fetch: transport(feedText(), VSIX),
    })

    const outcome = await updates.check('manual')

    expect(outcome).toMatchObject({ status: 'ineligible', code: 'version' })
    expect(outcome.status === 'ineligible' ? outcome.reason : '').toContain('not newer than the installed 0.2.0')
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('fails visibly when the feed cannot be reached and stays usable', async () => {
    const logged: string[] = []
    const updates = controller({
      // The intranet is unreachable: the current installation keeps working.
      fetch: async () => { throw new TypeError('getaddrinfo ENOTFOUND updates.lan') },
      log: line => { logged.push(line) },
    })

    const outcome = await updates.check('manual')

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome.status === 'failed' ? outcome.reason : '').toContain('could not be read')
    expect(updates.state).toMatchObject({ name: 'failed' })
    expect(logged.join('\n')).toContain('ENOTFOUND')
  })

  it('fails visibly when the feed is not a valid manifest', async () => {
    const updates = controller({ fetch: transport('{"schemaVersion":"dsh-vscode-update/v2"}', VSIX) })

    const outcome = await updates.check('manual')

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome.status === 'failed' ? outcome.reason : '').toContain('schemaVersion')
  })

  it('reports an HTTP status instead of reading the body', async () => {
    const updates = controller({
      fetch: async () => await new Response('maintenance', { status: 503 }),
    })

    const outcome = await updates.check('manual')

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome.status === 'failed' ? outcome.reason : '').toContain('HTTP 503')
  })

  it('refuses to install a download whose digest does not match the feed', async () => {
    const other = new Uint8Array(VSIX.byteLength).fill(3)
    const installed: string[] = []
    const updates = controller({
      fetch: transport(feedText(), other),
      install: async (staged) => {
        installed.push(staged.path)
        return { ok: true, version: staged.version }
      },
    })
    await updates.check('manual')

    const outcome = await updates.installAndReload()

    expect(outcome).toMatchObject({ status: 'failed', code: 'download' })
    expect(outcome.status === 'failed' ? outcome.reason : '').toContain('digest-mismatch')
    expect(installed).toEqual([])
    expect(updates.state).toMatchObject({ name: 'failed' })
  })

  it('installs nothing when the download is cancelled', async () => {
    const installed: string[] = []
    const updates = controller({
      fetch: transport(feedText(), VSIX),
      download: async () => ({ ok: false, failure: { code: 'cancelled', detail: 'the download was cancelled' } }),
      install: async (staged) => {
        installed.push(staged.path)
        return { ok: true, version: staged.version }
      },
    })
    await updates.check('manual')

    await expect(updates.installAndReload()).resolves.toMatchObject({ status: 'cancelled' })
    expect(installed).toEqual([])
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('keeps the verified file staged when running work defers the install', async () => {
    const requested: string[] = []
    const installs: string[] = []
    let attempt = 0
    const updates = controller({
      fetch: transport(feedText(), VSIX, requested),
      install: async (staged) => {
        installs.push(staged.version)
        attempt += 1
        return attempt === 1
          ? { ok: false, code: 'work-running', detail: 'a running turn is still using DSH' }
          : { ok: true, version: staged.version }
      },
    })
    await updates.check('manual')

    await expect(updates.installAndReload()).resolves.toMatchObject({
      status: 'deferred',
      reason: 'a running turn is still using DSH',
    })
    expect(updates.state).toMatchObject({ name: 'staged', version: '0.2.0' })

    // The next command installs the file already verified in global storage instead of downloading it again.
    await expect(updates.check('manual')).resolves.toMatchObject({ status: 'staged', staged: { version: '0.2.0' } })
    await expect(updates.installAndReload()).resolves.toMatchObject({ status: 'installed', version: '0.2.0' })
    expect(installs).toEqual(['0.2.0', '0.2.0'])
    expect(requested.filter(url => url === VSIX_URL)).toHaveLength(1)
  })

  it('reports a reload that did not happen as an installed version', async () => {
    const updates = controller({
      fetch: transport(feedText(), VSIX),
      install: async () => ({ ok: false, code: 'reload-failed', detail: 'the window did not reload' }),
    })
    await updates.check('manual')

    await expect(updates.installAndReload()).resolves.toMatchObject({
      status: 'installed',
      version: '0.2.0',
      reloaded: false,
    })
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('reports a failed host handover as installed but not reloaded', async () => {
    const updates = controller({
      fetch: transport(feedText(), VSIX),
      install: async () => ({
        ok: false,
        code: 'handover-failed',
        detail: 'DSH 0.2.0 is installed, but the previous DSH host did not stop',
      }),
    })
    await updates.check('manual')

    await expect(updates.installAndReload()).resolves.toMatchObject({
      status: 'installed',
      version: '0.2.0',
      reloaded: false,
      detail: 'DSH 0.2.0 is installed, but the previous DSH host did not stop',
    })
    expect(updates.state).toEqual({ name: 'idle' })
  })

  it('refuses a second install while one is running', async () => {
    const gate = Promise.withResolvers<void>()
    const updates = controller({
      fetch: transport(feedText(), VSIX),
      install: async () => {
        await gate.promise
        return { ok: true, version: '0.2.0' }
      },
    })
    await updates.check('manual')

    const first = updates.installAndReload()
    await flush()
    await expect(updates.installAndReload()).resolves.toMatchObject({ status: 'busy' })
    gate.resolve()
    await expect(first).resolves.toMatchObject({ status: 'installed' })
  })

  it('explains why nothing can be installed before a check produced a result', async () => {
    const updates = controller()
    await expect(updates.installAndReload()).resolves.toMatchObject({ status: 'nothing-to-install' })
  })

  it('starts nothing when the interval is 0 and checks once when it is not', async () => {
    const requested: string[] = []
    const off = controller({ fetch: transport(feedText(), VSIX, requested) })
    const stop = off.start()
    await flush()
    expect(requested).toEqual([])
    stop()

    const enabled = controller({
      checkIntervalMinutes: () => 30,
      fetch: transport(feedText(), VSIX, requested),
    })
    const stopEnabled = enabled.start()
    await flush()
    expect(requested).toEqual([FEED_URL])
    expect(enabled.state).toMatchObject({ name: 'available' })
    stopEnabled()
  })
})
