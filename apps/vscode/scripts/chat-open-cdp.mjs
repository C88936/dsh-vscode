/**
 * Explore the session tree in both DSH webviews, open each candidate, and
 * report whether the conversation shows the message and streamed answer.
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

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms) })

const listItems = `(() => {
  const doc = document.querySelector('iframe')?.contentDocument
  return JSON.stringify([...(doc?.querySelectorAll('[role="treeitem"]') ?? [])].map((item, index) => ({
    index,
    text: (item.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
  })))
})()`

const openSidebar = `(() => {
  const frame = document.querySelector('iframe')
  try {
    const button = frame?.contentDocument?.querySelector('[aria-label="打开侧边栏"]')
    if (button === null || button === undefined) return 'no button'
    button.click()
    return 'clicked'
  } catch (error) { return 'frame-error: ' + error.message }
})()`

const clickItem = index => `(() => {
  const doc = document.querySelector('iframe')?.contentDocument
  const items = [...(doc?.querySelectorAll('[role="treeitem"]') ?? [])]
  if (items[${String(index)}] === undefined) return 'missing'
  items[${String(index)}].click()
  return (items[${String(index)}].textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60)
})()`

const pageText = `(() => {
  const frame = document.querySelector('iframe')
  try { return frame?.contentDocument?.body?.innerText ?? '' } catch (error) { return 'frame-error: ' + error.message }
})()`

const targets = (await getJson('http://127.0.0.1:9333/json/list'))
  .filter(target => target.type === 'iframe' && String(target.url).includes('purpose=webviewView'))
process.stdout.write(`webviews: ${String(targets.length)}\n`)
if (targets.length < 2) process.exit(2)

let found = false
for (const [windowIndex, target] of targets.entries()) {
  const sidebar = await evaluate(target.webSocketDebuggerUrl, openSidebar)
  process.stdout.write(`window-${String(windowIndex + 1)} sidebar: ${String(sidebar)}\n`)
  await delay(1_500)
  const items = JSON.parse(String(await evaluate(target.webSocketDebuggerUrl, listItems)))
  process.stdout.write(`window-${String(windowIndex + 1)} items: ${JSON.stringify(items)}\n`)
  for (let index = 0; index < items.length; index++) {
    const clicked = await evaluate(target.webSocketDebuggerUrl, clickItem(index))
    await delay(700)
    const text = String(await evaluate(target.webSocketDebuggerUrl, pageText)).replace(/\s+/gu, ' ').trim()
    const hasAnswer = text.includes('hello from the LAN endpoint')
    const hasMessage = text.includes('hello from the two-window acceptance')
    if (hasAnswer || hasMessage) {
      process.stdout.write(`window-${String(windowIndex + 1)} item ${String(index)} (${String(clicked)}): message=${String(hasMessage)} answer=${String(hasAnswer)}\n`)
      process.stdout.write(`window-${String(windowIndex + 1)} text: ${text.slice(0, 400)}\n`)
      found = found || hasAnswer
      break
    }
  }
}
process.stdout.write(`found answer in at least one window: ${String(found)}\n`)
if (!found) process.exitCode = 1
