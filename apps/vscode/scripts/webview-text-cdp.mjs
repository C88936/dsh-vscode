/**
 * Print the visible text of every DSH webview over CDP.
 * Used by the two-window recovery probe.
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
      const timer = setTimeout(() => { reject(new Error('evaluation timed out')) }, 20_000)
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
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
  try { return frame?.contentDocument?.body?.innerText ?? '' } catch (error) { return 'frame-error: ' + error.message }
})()`

const targets = (await getJson('http://127.0.0.1:9333/json/list'))
  .filter(target => target.type === 'iframe' && String(target.url).includes('purpose=webviewView'))
process.stdout.write(`webviews: ${String(targets.length)}\n`)
for (const [index, target] of targets.entries()) {
  const text = String(await evaluate(target.webSocketDebuggerUrl, pageText)).replace(/\s+/gu, ' ').trim()
  process.stdout.write(`window-${String(index + 1)}: ${text.slice(0, 400)}\n`)
}
