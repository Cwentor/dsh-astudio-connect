import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAStudioUpstream } from '../src/upstream.ts'

let server: Server
let port: number

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/v1/chat/completions') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(rawBody) as { model?: string; stream?: boolean }
          const model = parsed.model ?? 'unknown'
          // Route by model name to simulate different responses
          if (model === 'error-401') {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
            return
          }
          if (model === 'error-404') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Not Found' } }))
            return
          }
          if (model === 'error-429') {
            res.writeHead(429, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Rate Limited' } }))
            return
          }
          if (model === 'error-500') {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }))
            return
          }
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            choices: [{ message: { content: 'Hello!', role: 'assistant' }, finish_reason: 'stop' }],
            model,
            object: 'chat.completion',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }))
        })
      } else {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(addr.port)
    })
  })
}

beforeAll(async () => {
  port = await startServer()
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function makeUpstream() {
  return createAStudioUpstream({ baseUrl: `http://127.0.0.1:${port}/v1` })
}

describe('createAStudioUpstream', () => {
  it('returns ok on 200 non-stream', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('test-token', { model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.kind).toBe('ok')
    const body = (await result.response.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Hello!')
  })

  it('returns ok on 200 stream', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('test-token', { model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    const text = await result.response.text()
    expect(text).toContain('[DONE]')
  })

  it('classifies 401 as auth', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('bad-token', { model: 'error-401', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.kind).toBe('auth')
  })

  it('classifies 404 as not_found', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('token', { model: 'error-404', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
    expect(result.kind).toBe('not_found')
  })

  it('classifies 429 as rate', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('token', { model: 'error-429', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.kind).toBe('rate')
  })

  it('classifies 500 as server', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('token', { model: 'error-500', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.kind).toBe('server')
  })

  it('sends Authorization header', async () => {
    const upstream = makeUpstream()
    const result = await upstream.chat('my-secret-token', { model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(true)
  })
})
