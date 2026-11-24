/**
 * Verify the built Webview transport: request metadata, abort, stream uplink,
 * and acknowledged binary upload chunks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'webview.iife.js'), 'utf8')
const handlers = new Map()
const sent = []
const context = {
  console,
  URL,
  URLSearchParams,
  Headers,
  Request,
  Response,
  Blob,
  ReadableStream,
  Uint8Array,
  ArrayBuffer,
  AbortController,
  DOMException,
  // The Webview page always has these; the sandbox states them explicitly.
  TextDecoder,
  TextEncoder,
  queueMicrotask,
  btoa,
  setTimeout,
  clearTimeout,
  acquireVsCodeApi: () => ({
    postMessage: frame => { sent.push(frame) },
  }),
  __DSH_BOOT_PAYLOAD__: {
    assets: {},
    nonce: 'transport-smoke',
    shell: 'transport-shell',
    injections: [],
  },
  window: {
    addEventListener: (name, listener) => { handlers.set(name, listener) },
  },
  document: {
    createElement: () => ({}),
    head: {
      append: element => { queueMicrotask(() => { element.onload?.() }) },
      insertAdjacentHTML: () => {},
    },
  },
}
vm.createContext(context)
vm.runInContext(bundle, context)

const transport = context.__DSH_TRANSPORT__
const upload = context.__DSH_FILE_UPLOAD__
const failures = []

function check(condition, label) {
  process.stdout.write(`${label}: ${String(condition)}\n`)
  if (!condition) failures.push(label)
}

async function nextFrame(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frame = sent.find(predicate)
    if (frame !== undefined) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const controller = new AbortController()
const fetchPromise = transport.fetch('/api/audit', {
  method: 'PUT',
  headers: { 'x-audit': 'yes' },
  body: 'audit-body',
  signal: controller.signal,
})
const fetchFrame = await nextFrame(frame => frame.type === 'fetch', 'fetch frame')
check(fetchFrame.method === 'PUT', 'fetch method forwarded')
check(fetchFrame.headers['x-audit'] === 'yes', 'fetch headers forwarded')
check(fetchFrame.body === 'audit-body', 'fetch text body forwarded')
controller.abort()
let fetchAborted = false
try {
  await fetchPromise
} catch (error) {
  fetchAborted = error instanceof Error && error.name === 'AbortError'
}
check(fetchAborted, 'fetch settles on abort')
check(sent.some(frame => frame.type === 'fetch-cancel' && frame.id === fetchFrame.id), 'fetch cancel sent')

// A standard Request object supplies its own method, headers, body, and signal.
const requestAnswer = transport.fetch(new Request('http://dsh.local/api/audit', {
  method: 'PATCH',
  headers: { 'x-from-request': 'yes' },
  body: 'request-body',
}))
const requestFrame = await nextFrame(frame => frame.type === 'fetch' && frame.method === 'PATCH', 'request frame')
check(requestFrame.headers['x-from-request'] === 'yes', 'Request headers forwarded')
check(requestFrame.body === 'request-body', 'Request body forwarded')
handlers.get('message')({ data: { type: 'fetch-result', id: requestFrame.id, status: 200, body: '{}' } })
check((await requestAnswer).status === 200, 'Request answer returned')

// A URL-only call is a GET; the Host decides, the carrier does not invent a POST.
const getAnswer = transport.fetch('/api/state')
const getFrame = await nextFrame(frame => frame.url === '/api/state', 'GET frame')
check(getFrame.method === 'GET', 'URL-only request is GET')
check(!('body' in getFrame), 'GET request has no body')
handlers.get('message')({ data: { type: 'fetch-result', id: getFrame.id, status: 200, body: '{}' } })
await getAnswer

// An already cancelled Request sends nothing at all.
const cancelled = new AbortController()
cancelled.abort()
const beforeCancel = sent.length
let cancelledRejected = false
try {
  await transport.fetch(new Request('http://dsh.local/api/audit', { method: 'PUT', body: 'x', signal: cancelled.signal }))
} catch (error) {
  cancelledRejected = error instanceof Error && error.name === 'AbortError'
}
check(cancelledRejected, 'cancelled Request rejects')
check(sent.length === beforeCancel, 'cancelled Request sends no frame')

const streamController = new AbortController()
const uplink = (async function * () {
  yield 'uplink-value'
  yield 'uplink-value-2'
})()
const iterator = transport
  .openStream('audit/echo', {}, streamController.signal, uplink)
  [Symbol.asyncIterator]()
const opened = iterator.next()
const streamFrame = await nextFrame(frame => frame.type === 'stream-open', 'stream open frame')
const itemFrame = await nextFrame(frame => frame.type === 'stream-item-send', 'stream uplink item')
handlers.get('message')({ data: { type: 'stream-uplink-ack', id: streamFrame.id, seq: itemFrame.seq } })
const secondFrame = await nextFrame(
  frame => frame.type === 'stream-item-send' && frame.seq !== itemFrame.seq,
  'second stream uplink item',
)
handlers.get('message')({ data: { type: 'stream-uplink-ack', id: streamFrame.id, seq: secondFrame.seq } })
const endFrame = await nextFrame(frame => frame.type === 'stream-end-send', 'stream uplink end')
handlers.get('message')({ data: { type: 'stream-uplink-ack', id: streamFrame.id, seq: endFrame.seq } })
handlers.get('message')({ data: { type: 'stream-end', id: streamFrame.id } })
await opened
check(itemFrame.item === 'uplink-value', 'stream uplink item forwarded')
check(secondFrame.item === 'uplink-value-2', 'second stream uplink item forwarded')
check(endFrame.id === streamFrame.id, 'stream uplink half-close forwarded')

check(typeof upload?.fetch === 'function', 'file upload carrier installed')
const uploadPromise = upload.fetch('/api/session/uploadFileBinary?sessionId=audit', {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: new Blob(['upload-body']),
})
const uploadFrame = await nextFrame(frame => frame.type === 'upload-open', 'upload open frame')
const chunkFrame = await nextFrame(frame => frame.type === 'upload-chunk', 'upload chunk')
handlers.get('message')({ data: { type: 'upload-ack', id: uploadFrame.id, seq: chunkFrame.seq } })
const uploadEnd = await nextFrame(frame => frame.type === 'upload-end', 'upload end')
handlers.get('message')({ data: { type: 'upload-ack', id: uploadFrame.id, seq: uploadEnd.seq } })
handlers.get('message')({ data: { type: 'upload-result', id: uploadFrame.id, status: 200, body: '{}' } })
const uploadResponse = await uploadPromise
const uploadText = Buffer.from(chunkFrame.data, 'base64').toString('utf8')
check(uploadFrame.method === 'POST', 'upload method forwarded')
check(uploadText === 'upload-body', 'upload bytes forwarded')
check(uploadResponse.status === 200, 'upload response returned')

if (failures.length > 0) {
  process.stderr.write(`transport smoke failures: ${failures.join(', ')}\n`)
  process.exitCode = 1
}
