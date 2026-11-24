/**
 * Ask one window's page transport for a module change and report the answer.
 * Used by the maintenance-gate UI probe.
 */
import http from 'node:http'

/**
 * @param {string} url - HTTP URL.
 * @returns {Promise<any>} decoded JSON.
 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

const parentId = process.argv[2] ?? '2'
const method = process.argv[3] ?? 'pluginManager/setPluginEnabled'
const argsJson = process.argv[4] ?? '{"id":"no-such-plugin","enabled":true}'

/**
 * @param {string} url - debugger WebSocket URL.
 * @param {string} expression - expression to evaluate.
 * @returns {Promise<any>} value.
 */
async function evaluate(url, expression) {
  const socket = await new Promise((resolve, reject) => {
    const candidate = new WebSocket(url)
    candidate.onopen = () => { resolve(candidate) }
    candidate.onerror = () => { reject(new Error('websocket failed')) }
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('evaluation timed out')) }, 60_000)
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.result?.exceptionDetails !== undefined) {
          reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
          return
        }
        resolve(message.result?.result?.value)
      }
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
  } finally {
    socket.close()
  }
}

const source = `(async () => {
  const call = async (method, args) => {
    const response = await __DSH_TRANSPORT__.fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'gate-' + method + '-' + Math.random(), method, payload: { args } }),
    })
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 800) }
  }
  return await call(${JSON.stringify(method)}, ${argsJson})
})()`

const targets = await getJson('http://127.0.0.1:9333/json/list')
const target = targets.find(candidate => candidate.type === 'iframe'
  && String(candidate.url).includes('purpose=webviewView')
  && String(candidate.url).includes(`parentId=${parentId}`))
if (target === undefined) {
  process.stdout.write(`no webview for parent ${parentId}\n`)
  process.exit(1)
}
const expression = `(async () => {
  const frame = document.querySelector('iframe')
  return await frame.contentWindow.eval(${JSON.stringify(source)})
})()`
let last = null
for (let attempt = 0; attempt < 25; attempt++) {
  last = await evaluate(target.webSocketDebuggerUrl, expression)
  const body = String(last?.body ?? '')
  process.stdout.write(`attempt ${String(attempt + 1)}: status=${String(last?.status)} body=${body.slice(0, 300)}\n`)
  if (body.includes('maintenance-busy')) break
  await new Promise(resolve => { setTimeout(resolve, 300) })
}
process.stdout.write(`final: ${JSON.stringify(last)}\n`)
