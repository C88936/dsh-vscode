/**
 * Inspect one DSH webview's DOM: current route, interactive controls, and text.
 * Used to find how the page opens a session created over the transport.
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
      const timer = setTimeout(() => { reject(new Error('evaluation timed out')) }, 30_000)
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

const inspect = `(() => {
  const frame = document.querySelector('iframe')
  const doc = frame?.contentDocument
  const win = frame?.contentWindow
  const controls = [...(doc?.querySelectorAll('button,a,[role="button"],[role="link"],[tabindex]') ?? [])]
    .map(element => ({
      text: (element.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 70),
      aria: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      href: element.getAttribute('href'),
      role: element.getAttribute('role'),
    }))
    .filter(item => (item.text !== '' || item.aria !== null || item.title !== null) && (item.text.includes('C9') || item.text.includes('会话') || item.aria !== null || item.href !== null))
    .slice(0, 60)
  return JSON.stringify({
    href: win?.location.href,
    hash: win?.location.hash,
    text: (doc?.body?.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 500),
    controls,
  })
})()`

const targets = (await getJson('http://127.0.0.1:9333/json/list'))
  .filter(target => target.type === 'iframe' && String(target.url).includes('purpose=webviewView'))
process.stdout.write(`webviews: ${String(targets.length)}\n`)
if (targets.length === 0) process.exit(2)
const result = await evaluate(targets[0].webSocketDebuggerUrl, inspect)
process.stdout.write(`${String(result)}\n`)
