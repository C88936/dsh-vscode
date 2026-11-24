/**
 * Read the DSH webview documents over the VS Code remote-debugging endpoint and
 * rename the shared blank session through the page transport, then report
 * whether both windows show the new title.
 * Used only for the two-window acceptance probe.
 */
import http from 'node:http'

/**
 * @param {string} url - HTTP URL to read.
 * @returns {Promise<any>} decoded JSON body.
 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

/**
 * @param {string} url - debugger WebSocket URL.
 * @returns {Promise<WebSocket>} the open socket.
 */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => { resolve(socket) }
    socket.onerror = () => { reject(new Error('websocket failed')) }
  })
}

/**
 * @param {string} url - debugger WebSocket URL.
 * @param {string} expression - JavaScript expression to evaluate.
 * @returns {Promise<any>} the evaluated value.
 */
async function evaluate(url, expression, timeoutMs = 30_000) {
  const socket = await openSocket(url)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('evaluation timed out')) }, timeoutMs)
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

const pageText = `(() => {
  const frame = document.querySelector('iframe')
  try {
    const doc = frame?.contentDocument
    const controls = [...(doc?.querySelectorAll('button,[role="button"],a') ?? [])]
      .map(element => ({
        text: (element.textContent ?? '').trim().slice(0, 40),
        aria: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
      }))
      .filter(item => item.text !== '' || item.aria !== null || item.title !== null)
    return JSON.stringify({ text: (doc?.body?.innerText ?? '').slice(0, 300), controls: controls.slice(0, 40) })
  } catch (error) {
    return 'frame-error: ' + error.message
  }
})()`

const renameSource = `(async () => {
  const call = async (method, args) => {
    const response = await __DSH_TRANSPORT__.fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'cdp-' + method, method, payload: { args } }),
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { status: response.status, text: text.slice(0, 200) }
    }
  }
  const list = await call('session/list', { _request: {} })
  const sessionId = list.result?.value?.items?.[0]?.sessionId
  if (sessionId === undefined) return 'no session: ' + JSON.stringify(list).slice(0, 200)
  const renamed = await call('session/rename', { request: { sessionId, title: 'C9 shared title' } })
  return JSON.stringify({ sessionId, value: renamed.result?.value, error: renamed.result?.error })
})()`

const renameExpression = `(async () => {
  const frame = document.querySelector('iframe')
  return await frame.contentWindow.eval(${JSON.stringify(renameSource)})
})()`

const openSidebar = `(() => {
  const frame = document.querySelector('iframe')
  try {
    const button = frame?.contentDocument?.querySelector('[aria-label="打开侧边栏"]')
    if (button === null || button === undefined) return 'no sidebar button'
    button.click()
    return 'clicked'
  } catch (error) {
    return 'frame-error: ' + error.message
  }
})()`

const targets = await getJson('http://127.0.0.1:9333/json/list')
const webviews = targets.filter(target => target.type === 'iframe' && String(target.url).includes('purpose=webviewView'))
process.stdout.write(`dsh webview targets: ${String(webviews.length)}\n`)
if (webviews.length < 2) process.exit(2)

const [first, second] = webviews
process.stdout.write(`rename: ${String(await evaluate(first.webSocketDebuggerUrl, renameExpression))}\n`)
await new Promise(resolve => { setTimeout(resolve, 1_500) })
for (const [index, target] of [first, second].entries()) {
  process.stdout.write(`window-${String(index + 1)} sidebar: ${String(await evaluate(target.webSocketDebuggerUrl, openSidebar))}\n`)
}
await new Promise(resolve => { setTimeout(resolve, 1_500) })
for (const [index, target] of [first, second].entries()) {
  const text = String(await evaluate(target.webSocketDebuggerUrl, pageText))
  process.stdout.write(`window-${String(index + 1)} has title: ${String(text.includes('C9 shared title'))}\n`)
  process.stdout.write(`window-${String(index + 1)} text: ${text.replace(/\s+/gu, ' ').trim().slice(0, 300)}\n`)
}
