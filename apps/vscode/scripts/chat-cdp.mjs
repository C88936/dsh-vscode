/**
 * Drive one chat turn in the first DSH webview over CDP and verify that both
 * open windows show the session title and the streamed answer.
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
      const timer = setTimeout(() => { reject(new Error('evaluation timed out')) }, 90_000)
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
  try { return frame?.contentDocument?.body?.innerText ?? '' } catch (error) { return 'frame-error: ' + error.message }
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

const chat = `(async () => {
  const call = async (method, args) => {
    const response = await __DSH_TRANSPORT__.fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + method + '-' + Math.random(), method, payload: { args } }),
    })
    const text = await response.text()
    try { return JSON.parse(text) } catch { return { status: response.status, text: text.slice(0, 300) } }
  }
  const created = await call('session/create', { request: {} })
  const sessionId = created.result?.value?.sessionId
  if (sessionId === undefined) return 'create failed: ' + JSON.stringify(created).slice(0, 300)
  await call('session/rename', { request: { sessionId, title: 'C9 shared chat' } })
  const catalog = await call('session/modelCatalog', {})
  const value = catalog.result?.value
  const groups = value?.groups ?? []
  const chosen = value?.default?.provider !== undefined && value?.default?.model !== undefined
    ? value.default
    : groups[0]?.models?.[0] !== undefined ? { provider: groups[0].id, model: groups[0].models[0].id } : undefined
  if (chosen === undefined) return 'no model: ' + JSON.stringify(value ?? catalog).slice(0, 500)
  const selected = await call('session/selectModel', { request: { sessionId, provider: chosen.provider, model: chosen.model } })
  const prompted = await call('session/prompt', {
    request: { requestId: 'probe-' + Math.random().toString(16).slice(2), sessionId, mode: 'queue', content: [{ type: 'text', text: 'hello from the two-window acceptance' }] },
  })
  return JSON.stringify({
    sessionId,
    defaultModel: value?.default,
    groups: groups.map(group => ({ id: group.id, models: group.models.map(model => model.id) })),
    failures: value?.failures,
    chosen,
    selected: selected.result?.error ?? selected.result?.ok,
    prompted: prompted.result?.error ?? prompted.result?.ok,
  })
})()`

const inFrame = expression => `(async () => {
  const frame = document.querySelector('iframe')
  return await frame.contentWindow.eval(${JSON.stringify(expression)})
})()`

const targets = (await getJson('http://127.0.0.1:9333/json/list'))
  .filter(target => target.type === 'iframe' && String(target.url).includes('purpose=webviewView'))
process.stdout.write(`webviews: ${String(targets.length)}\n`)
if (targets.length < 2) process.exit(2)
for (const target of targets) await evaluate(target.webSocketDebuggerUrl, openSidebar)

const started = await evaluate(targets[0].webSocketDebuggerUrl, inFrame(chat))
process.stdout.write(`chat: ${String(started)}\n`)

const deadline = Date.now() + 120_000
let first = ''
let second = ''
let sawAnswer = false
let sawTitle = false
while (Date.now() <= deadline) {
  first = String(await evaluate(targets[0].webSocketDebuggerUrl, pageText))
  second = String(await evaluate(targets[1].webSocketDebuggerUrl, pageText))
  sawTitle = first.includes('C9 shared chat') && second.includes('C9 shared chat')
  sawAnswer = first.includes('hello from the LAN endpoint') && second.includes('hello from the LAN endpoint')
  if (sawTitle && sawAnswer) break
  await new Promise(resolve => { setTimeout(resolve, 2_000) })
}
process.stdout.write(`window-1 has title: ${String(sawTitle)}\n`)
process.stdout.write(`window-2 has title: ${String(sawTitle)}\n`)
process.stdout.write(`window-1 has answer: ${String(sawAnswer)}\n`)
process.stdout.write(`window-2 has answer: ${String(sawAnswer)}\n`)
process.stdout.write(`window-1 text: ${first.replace(/\s+/gu, ' ').trim().slice(0, 300)}\n`)
process.stdout.write(`window-2 text: ${second.replace(/\s+/gu, ' ').trim().slice(0, 300)}\n`)
if (!(sawTitle && sawAnswer)) process.exitCode = 1
