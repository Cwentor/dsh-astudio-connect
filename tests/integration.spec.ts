/**
 * Integration test: exercises the full auth → upstream → shim → adapter
 * chain with a mock upstream server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioAuth } from '../src/auth.ts'
import { createAStudioUpstream } from '../src/upstream.ts'
import { createAStudioCatalog } from '../src/catalog.ts'
import { createAStudioShim } from '../src/shim.ts'
import { createAStudioAdapter } from '../src/adapter.ts'
import { ASTRO_PROVIDER } from '../src/adapter.ts'

let mockServer: Server
let mockPort: number
let testFile: string
let shim: ReturnType<typeof createAStudioShim>

function startMockUpstream(): Promise<number> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model?: string
          stream?: boolean
          messages?: Array<{ role: string; content: string }>
          tools?: unknown[]
        }
        const model = parsed.model ?? 'spark-x2.5'

        // Tool call test
        if (parsed.tools && parsed.tools.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                content: '',
                role: 'assistant',
                tool_calls: [{
                  id: 'call_test',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
                }],
              },
            }],
            model,
            object: 'chat.completion',
          }))
          return
        }

        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: { content: 'Hello from integration!', role: 'assistant', reasoning_content: 'thinking...' },
          }],
          model,
          object: 'chat.completion',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
      })
    })
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address() as AddressInfo
      resolve(addr.port)
    })
  })
}

beforeAll(async () => {
  mockPort = await startMockUpstream()
  testFile = join(tmpdir(), `astudio-integration-${Date.now()}.toml`)
  writeFileSync(testFile, `experimental_bearer_token = "integration_test_token"`, 'utf8')
})

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  if (existsSync(testFile)) unlinkSync(testFile)
})

beforeEach(async () => {
  const store = createAStudioAuth({ configPath: testFile })
  const upstream = createAStudioUpstream({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
  const catalog = createAStudioCatalog({
    upstream,
    token: () => store.resolve(),
    modelManagerBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
  })
  shim = createAStudioShim({ store, upstream, catalog })
  await shim.ready
})

afterEach(async () => {
  await shim.close()
})

function shimHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${shim.token()}`,
    'Content-Type': 'application/json',
    Host: '127.0.0.1',
  }
}

describe('integration', () => {
  it('non-stream request through full chain', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Hello from integration!')
  })

  it('stream request through full chain', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('[DONE]')
  })

  it('tool call through full chain', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({
        model: 'spark-x2.5',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('get_weather')
    expect(text).toContain('Beijing')
  })

  it('adapter lists models from catalog', async () => {
    const store = createAStudioAuth({ configPath: testFile })
    const upstream = createAStudioUpstream({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
    const catalog = createAStudioCatalog({
      upstream,
      token: () => store.resolve(),
      modelManagerBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
    })
    const shim2 = createAStudioShim({ store, upstream, catalog })
    await shim2.ready

    const { adapter } = createAStudioAdapter({ shim: shim2, catalog })
    const models = await adapter.listModels(ASTRO_PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.id).toBe('spark-x2.5')

    await shim2.close()
  })

  it('reasoning_content appears in response', async () => {
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'think' }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // The mock returns reasoning_content in the non-stream response
    expect(text).toContain('reasoning_content')
  })
})
