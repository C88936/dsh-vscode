/**
 * OpenAI-compatible mock that waits before answering, so a turn stays running
 * long enough to observe the maintenance gate.
 */
import { createServer } from 'node:http'

const port = Number.parseInt(process.argv[2] ?? '18081', 10)
const delayMs = Number.parseInt(process.argv[3] ?? '12000', 10)

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'company-model' }] }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404)
    response.end()
    return
  }
  request.on('data', () => {})
  request.on('end', () => {
    process.stdout.write('completion request received\n')
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'company-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.write(chunk({ role: 'assistant', content: 'slow answer from the LAN endpoint' }, null))
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    }, delayMs)
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`slow mock listening on http://127.0.0.1:${String(port)}/v1\n`)
})
