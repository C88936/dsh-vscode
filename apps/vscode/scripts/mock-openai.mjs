/**
 * Minimal OpenAI-compatible endpoint for manual verification.
 *
 * Serves `GET /v1/models` and streams a Chat Completions answer, so a private
 * route can be exercised without the company gateway.
 *
 * Usage: node scripts/mock-openai.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number.parseInt(process.argv[2] ?? '18080', 10)

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
  let raw = ''
  request.on('data', (chunk) => { raw += String(chunk) })
  request.on('end', () => {
    process.stdout.write(`request: ${raw.slice(0, 240)}\n`)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'company-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(chunk({ role: 'assistant', content: 'hello from the LAN endpoint' }, null))
    response.write(chunk({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock openai listening on http://127.0.0.1:${String(port)}/v1\n`)
})
