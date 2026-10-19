import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioAuth } from '../src/auth.ts'
import { createAStudioUpstream } from '../src/upstream.ts'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'
import { createAStudioShim } from '../src/shim.ts'

const TEST_TOKEN = 'test_token_12345'
let mockUpstream: Server
let mockPort: number
let testFile: string
let shim: ReturnType<typeof createAStudioShim>

function startMockUpstream(): Promise<number> {
  return new Promise((resolve) => {
    mockUpstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean; model?: string }
        if (body.model === 'error-401') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
          return
        }
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Hello from upstream!', role: 'assistant' }, finish_reason: 'stop' }],
          model: body.model ?? 'spark-x2.5',
          object: 'chat.completion',
        }))
      })
    })
    mockUpstream.listen(0, '127.0.0.1', () => {
      const addr = mockUpstream.address() as AddressInfo
      resolve(addr.port)
    })
  })
}

beforeAll(async () => {
  mockPort = await startMockUpstream()
  testFile = join(tmpdir(), `astudio-shim-test-${Date.now()}.toml`)
  writeFileSync(testFile, `experimental_bearer_token = "${TEST_TOKEN}"`, 'utf8')
})

afterAll(async () => {
  await new Promise<void>((resolve) => mockUpstream.close(() => resolve()))
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

function shimUrl(path: string): string {
  return `${shim.baseUrl()}${path}`
}

function shimHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${shim.token()}`,
    'Content-Type': 'application/json',
    Host: '127.0.0.1',
  }
}

/** Send a raw HTTP request with custom Host header. */
function rawRequest(hostHeader: string, port: number, path: string, method = 'GET'): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { Host: hostHeader } },
      (res) => {
        resolve({ status: res.statusCode ?? 0 })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('createAStudioShim', () => {
  it('GET /healthz returns ok', async () => {
    const res = await fetch(shimUrl('/healthz'), { headers: shimHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('GET /v1/models returns catalog', async () => {
    const res = await fetch(shimUrl('/v1/models'), { headers: shimHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data[0]?.id).toBe(DEFAULT_CATALOG[0]?.id)
  })

  it('POST /v1/chat/completions non-stream forwards to upstream', async () => {
    const res = await fetch(shimUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    // Non-stream: shim wraps in SSE envelope, so we read text
    const text = await res.text()
    expect(text).toContain('Hello from upstream!')
  })

  it('POST /v1/chat/completions stream forwards to upstream', async () => {
    const res = await fetch(shimUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: shimHeaders(),
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('[DONE]')
  })

  it('rejects non-loopback Host', async () => {
    // Node.js fetch overrides Host header, so use raw http.request
    const port = parseInt(shim.baseUrl().split(':').pop() ?? '0', 10)
    const result = await rawRequest('evil.example.com', port, '/healthz')
    expect(result.status).toBe(403)
  })

  it('rejects non-loopback Origin', async () => {
    const res = await fetch(shimUrl('/healthz'), {
      headers: { ...shimHeaders(), Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects wrong bearer token', async () => {
    const res = await fetch(shimUrl('/healthz'), {
      headers: { ...shimHeaders(), Authorization: 'Bearer wrong-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects missing bearer token', async () => {
    const res = await fetch(shimUrl('/healthz'), {
      headers: { Host: '127.0.0.1' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects non-JSON Content-Type on POST', async () => {
    const res = await fetch(shimUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: { ...shimHeaders(), 'Content-Type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(shimUrl('/v1/unknown'), { headers: shimHeaders() })
    expect(res.status).toBe(404)
  })

  it('returns 401 when token not available', async () => {
    // Use a store pointing to a missing file
    const emptyFile = join(tmpdir(), `astudio-empty-${Date.now()}.toml`)
    const store2 = createAStudioAuth({ configPath: emptyFile })
    const upstream2 = createAStudioUpstream({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
    const catalog2 = createAStudioCatalog({
      upstream: upstream2,
      token: () => store2.resolve(),
      modelManagerBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
    })
    const shim2 = createAStudioShim({ store: store2, upstream: upstream2, catalog: catalog2 })
    await shim2.ready
    const res = await fetch(`${shim2.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...shimHeaders(), Authorization: `Bearer ${shim2.token()}` },
      body: JSON.stringify({ model: 'spark-x2.5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
    await shim2.close()
    if (existsSync(emptyFile)) unlinkSync(emptyFile)
  })
})
