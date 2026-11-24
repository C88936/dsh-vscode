/**
 * Sample the shared host's activity through a real bridge connection.
 * Used to verify whether a UI-started turn is counted as running work.
 */
import { resolveHostEndpoint, createHostToken } from '../src/shared/host-endpoint.ts'
import { attachSharedHost } from '../src/host/shared-host-process.ts'
import { DEFAULT_BRIDGE_LIMITS } from '../src/shared/limits.ts'

const storageDir = process.argv[2] ?? ''
const seconds = Number.parseInt(process.argv[3] ?? '15', 10)
if (storageDir === '') {
  process.stdout.write('usage: activity-sampler.ts <storage-dir> [seconds]\n')
  process.exit(2)
}
const endpoint = resolveHostEndpoint(storageDir)
const token = createHostToken(endpoint.tokenPath)
const bridge = await attachSharedHost({
  endpoint: endpoint.endpoint,
  token,
  clientId: 'activity-sampler',
  extensionVersion: '0.0.0-probe',
  configFingerprint: 'activity-probe',
  limits: DEFAULT_BRIDGE_LIMITS,
  workspacePath: storageDir,
  webview: { asUri: path => `uri:${path}`, postMessage: async () => {} },
  log: line => { process.stderr.write(`${line}\n`) },
})
const deadline = Date.now() + seconds * 1_000
while (Date.now() <= deadline) {
  const activity = await bridge.activity()
  process.stdout.write(`activity: ${JSON.stringify(activity?.activity ?? null)}\n`)
  await new Promise(resolve => { setTimeout(resolve, 500) })
}
await bridge.dispose()
