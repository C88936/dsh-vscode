/**
 * Ask the extension to run the shared maintenance restart from one window's
 * page transport. Used by the two-window recovery probe.
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
const targets = await getJson('http://127.0.0.1:9333/json/list')
const target = targets.find(candidate => candidate.type === 'iframe'
  && String(candidate.url).includes('purpose=webviewView')
  && String(candidate.url).includes(`parentId=${parentId}`))
if (target === undefined) {
  process.stdout.write(`no webview for parent ${parentId}\n`)
  process.exit(1)
}
const socket = await new Promise((resolve, reject) => {
  const candidate = new WebSocket(target.webSocketDebuggerUrl)
  candidate.onopen = () => { resolve(candidate) }
  candidate.onerror = () => { reject(new Error('websocket failed')) }
})
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('restart evaluation timed out')) }, 60_000)
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== 1) return
    clearTimeout(timer)
    resolve(message.result?.result?.value)
  }
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => { const frame = document.querySelector('iframe'); return await frame.contentWindow.eval('__DSH_TRANSPORT__.restartHost()') })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
process.stdout.write(`restart requested: ${String(result)}\n`)
socket.close()
