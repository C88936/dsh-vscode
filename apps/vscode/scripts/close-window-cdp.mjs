/**
 * Close one VS Code window through the remote-debugging page target.
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

const marker = process.argv[2] ?? 'workspace-a'
const targets = await getJson('http://127.0.0.1:9333/json/list')
const page = targets.find(target => target.type === 'page' && String(target.title).includes(marker))
if (page === undefined) {
  process.stdout.write(`no page target for ${marker}\n`)
  process.exit(1)
}
process.stdout.write(`closing: ${String(page.title)}\n`)
const socket = await new Promise((resolve, reject) => {
  const candidate = new WebSocket(page.webSocketDebuggerUrl)
  candidate.onopen = () => { resolve(candidate) }
  candidate.onerror = () => { reject(new Error('websocket failed')) }
})
socket.send(JSON.stringify({ id: 1, method: 'Page.close' }))
await new Promise(resolve => { setTimeout(resolve, 1_000) })
socket.close()
process.stdout.write('close requested\n')
