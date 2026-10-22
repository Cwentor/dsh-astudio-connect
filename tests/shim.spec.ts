import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioAuth } from '../src/auth.ts'
import { createAStudioUpstream } from '../src/upstream.ts'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'
import { createAStudioShim, sanitizeGatewayBody, repairChatBody, dropUnsupportedEffort } from '../src/shim.ts'

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

/**
 * maas-api answers a body it does not model with one opaque 400 and no field
 * name, so the shim's only lever is to ask again with less. These tests pin
 * that ladder: narrow after a 400, stop on a real failure, remember the shape.
 */
describe('gateway shape fallback', () => {
  let gateway: Server
  let gatewayBase = ''
  let seen: Array<Record<string, unknown>> = []
  let rejection: (body: Record<string, unknown>) => number | undefined

  async function startGateway(decide: (body: Record<string, unknown>) => number | undefined): Promise<void> {
    rejection = decide
    seen = []
    gateway = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        seen.push(body)
        const status = rejection(body)
        if (status !== undefined) {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: { code: 10005, message: 'invalid request', type: 'invalid_request_error' },
            id: 'cht000d8904@dx1a16308c0f72160503',
          }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', () => resolve()))
    gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`
  }

  async function startShim(): Promise<{ url: string, token: string, warnings: string[] }> {
    const store = createAStudioAuth({ configPath: testFile })
    const upstream = createAStudioUpstream({ baseUrl: gatewayBase })
    const catalog = createAStudioCatalog({
      upstream,
      token: () => store.resolve(),
      modelManagerBaseUrl: gatewayBase,
    })
    const warnings: string[] = []
    const local = createAStudioShim({
      store,
      upstream,
      catalog,
      logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])), error: () => {} },
    })
    await local.ready
    const url = `${local.baseUrl()}/v1/chat/completions`
    const token = local.token()
    afterEach(async () => { await local.close() })
    return { url, token, warnings }
  }

  /** A body shaped like the one pi-ai emits for this provider. */
  function platformBody(): Record<string, unknown> {
    return {
      model: 'xopdeepseekv4pro',
      messages: [
        { role: 'developer', content: 'You are a helpful coding assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_tokens: 256,
    }
  }

  async function post(url: string, token: string, body: unknown): Promise<number> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Host: '127.0.0.1' },
      body: JSON.stringify(body),
    })
    await res.text()
    return res.status
  }

  afterEach(async () => {
    await new Promise<void>(resolve => gateway.close(() => resolve()))
  })

  it('drops platform-only fields and the developer role after a 400', async () => {
    await startGateway(body => ('store' in body || 'stream_options' in body ? 400 : undefined))
    const { url, token, warnings } = await startShim()

    expect(await post(url, token, platformBody())).toBe(200)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.store).toBe(false)
    expect(seen[1]).not.toHaveProperty('store')
    expect(seen[1]).not.toHaveProperty('stream_options')
    expect((seen[1]?.messages as Array<{ role: string }>)[0]?.role).toBe('system')
    expect(warnings.join('\n')).toContain('store')

    // The accepted shape is sticky: the next request costs a single round trip.
    expect(await post(url, token, platformBody())).toBe(200)
    expect(seen).toHaveLength(3)
  })

  it('flattens text-only content when even the narrower shape is refused', async () => {
    const hasContentArray = (body: Record<string, unknown>): boolean =>
      (body.messages as Array<{ content: unknown }>).some(message => Array.isArray(message.content))
    await startGateway(body => (hasContentArray(body) ? 400 : undefined))
    const { url, token } = await startShim()

    expect(await post(url, token, platformBody())).toBe(200)
    expect(seen).toHaveLength(3)
    const accepted = seen[2]?.messages as Array<{ role: string, content: unknown }>
    expect(accepted[1]?.content).toBe('hi')
  })

  it('names the request it gave up on when every shape is refused', async () => {
    await startGateway(() => 400)
    const { url, token } = await startShim()

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Host: '127.0.0.1' },
      body: JSON.stringify(platformBody()),
    })
    const payload = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(seen).toHaveLength(3)
    expect(payload.error.message).toContain('request: model=xopdeepseekv4pro')
    expect(payload.error.message).toContain('max_tokens=256')
    // Structure only: the prompt never reaches the error surface.
    expect(payload.error.message).not.toContain('helpful coding assistant')
  })

  it('surfaces a real upstream failure instead of narrowing the body', async () => {
    await startGateway(() => 500)
    const { url, token } = await startShim()

    expect(await post(url, token, platformBody())).toBe(502)
    expect(seen).toHaveLength(1)
  })

  describe('sanitizeGatewayBody', () => {
    it('leaves the body untouched for the as-is shape', () => {
      const body = platformBody()
      expect(sanitizeGatewayBody(body, 'as-is')).toBe(body)
    })

    it('keeps what the wire format requires', () => {
      const narrowed = sanitizeGatewayBody(platformBody(), 'optional-fields') as Record<string, unknown>
      expect(narrowed.model).toBe('xopdeepseekv4pro')
      expect(narrowed.max_tokens).toBe(256)
      expect(narrowed.stream).toBe(true)
      expect(narrowed).not.toHaveProperty('metadata')
    })

    it('flattens only single-part text content', () => {
      const shaped = sanitizeGatewayBody({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'x' } }] },
        ],
      }, 'text-only-content') as { messages: Array<{ content: unknown }> }
      expect(shaped.messages[0]?.content).toBe('a\n\nb')
      expect(Array.isArray(shaped.messages[1]?.content)).toBe(true)
    })

    it('passes non-objects through', () => {
      expect(sanitizeGatewayBody('nope', 'optional-fields')).toBe('nope')
      expect(sanitizeGatewayBody(undefined, 'text-only-content')).toBeUndefined()
    })
  })
})

/**
 * maas-api validates the body strictly and answers every violation with the
 * same field-less `10005`. Each case here was reproduced against the live
 * gateway, so these tests pin what the gateway actually accepts rather than
 * what the OpenAI docs say it should.
 */
describe('wire repair', () => {
  it('replaces null tool content with an empty string', () => {
    const { body, repairs } = repairChatBody({
      messages: [{ role: 'tool', tool_call_id: 'c1', content: null }],
    }) as { body: { messages: Array<{ content: unknown }> }, repairs: string[] }
    expect(body.messages[0]?.content).toBe('')
    expect(repairs.join()).toContain('null content')
  })

  it('re-serializes tool-call arguments objects into JSON strings', () => {
    const { body, repairs } = repairChatBody({
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: { path: 'a' } } }],
      }],
    }) as { body: { messages: Array<{ tool_calls: Array<{ function: { arguments: unknown } }> }> }, repairs: string[] }
    expect(body.messages[0]?.tool_calls[0]?.function.arguments).toBe('{"path":"a"}')
    expect(repairs.join()).toContain('re-serialized')
  })

  it('drops a tool result that names no call', () => {
    const { body, repairs } = repairChatBody({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', content: 'orphan' },
      ],
    }) as { body: { messages: unknown[] }, repairs: string[] }
    expect(body.messages).toHaveLength(1)
    expect(repairs.join()).toContain('no tool_call_id')
  })

  it('drops a tool call with no id and leaves a clean body alone', () => {
    const withBadCall = repairChatBody({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read', arguments: '{}' } }] },
      ],
    }) as { body: { messages: Array<Record<string, unknown>> } }
    expect(withBadCall.body.messages[1]).not.toHaveProperty('tool_calls')

    const clean = { model: 'm', messages: [{ role: 'user', content: 'go' }] }
    expect(repairChatBody(clean)).toEqual({ body: clean, repairs: [] })
  })

  it('leaves non-objects and message-less bodies untouched', () => {
    expect(repairChatBody('nope')).toEqual({ body: 'nope', repairs: [] })
    expect(repairChatBody({ model: 'm' })).toEqual({ body: { model: 'm' }, repairs: [] })
  })
})

describe('reasoning effort guard', () => {
  const models = [
    { id: 'spark-x2.5', reasoning: { supports: true, supportedEfforts: ['high'], canDisableThinking: true } },
    { id: 'xopdeepseekv4pro', reasoning: { supports: false } },
  ]

  it('keeps an effort the model declares', () => {
    const body = { model: 'spark-x2.5', reasoning_effort: 'high' }
    expect(dropUnsupportedEffort(body, models)).toEqual({ body })
  })

  it('accepts the literal none that upstream uses for thinking off', () => {
    const body = { model: 'spark-x2.5', reasoning_effort: 'none' }
    expect(dropUnsupportedEffort(body, models)).toEqual({ body })
  })

  it('renames off to the word upstream uses for it', () => {
    const { body, dropped } = dropUnsupportedEffort({ model: 'spark-x2.5', reasoning_effort: 'off' }, models)
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe('none')
    expect(dropped).toContain('none')
  })

  it('drops off for a model that cannot switch thinking off', () => {
    const fixed = [{ id: 'fixed', reasoning: { supports: true, supportedEfforts: ['high'] } }]
    const { body } = dropUnsupportedEffort({ model: 'fixed', reasoning_effort: 'off' }, fixed)
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('drops any effort for a model that does not reason', () => {
    const { body, dropped } = dropUnsupportedEffort({ model: 'xopdeepseekv4pro', reasoning_effort: 'high' }, models)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(dropped).toContain('does not accept')
  })

  it('leaves unknown models and absent efforts alone', () => {
    const unknown = { model: 'someone-else', reasoning_effort: 'high' }
    expect(dropUnsupportedEffort(unknown, models)).toEqual({ body: unknown })
    const absent = { model: 'spark-x2.5' }
    expect(dropUnsupportedEffort(absent, models)).toEqual({ body: absent })
  })
})

/**
 * When every shape is refused, the shim interrogates the gateway instead of
 * guessing: it drops one dimension at a time, bisects the offending array, and
 * retries with the defect removed. These tests use a stand-in gateway that
 * refuses the same way maas-api does.
 */
describe('self-diagnosis', () => {
  let gateway: Server
  let seen: Array<Record<string, unknown>> = []

  async function startGateway(decide: (body: Record<string, unknown>) => number | undefined): Promise<void> {
    seen = []
    gateway = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        seen.push(body)
        const status = decide(body)
        if (status !== undefined) {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 10005, message: 'invalid request' }, id: 'cht_x' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', () => resolve()))
  }

  async function startShim(): Promise<{ url: string, token: string, warnings: string[] }> {
    const store = createAStudioAuth({ configPath: testFile })
    const upstream = createAStudioUpstream({ baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1` })
    const catalog = createAStudioCatalog({ upstream, token: () => store.resolve() })
    const warnings: string[] = []
    const local = createAStudioShim({
      store,
      upstream,
      catalog,
      logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])), error: () => {} },
    })
    await local.ready
    afterEach(async () => { await local.close() })
    return { url: `${local.baseUrl()}/v1/chat/completions`, token: local.token(), warnings }
  }

  function toolsWithOneBroken(): unknown[] {
    const healthy = Array.from({ length: 8 }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${i}`, description: 'Fine.', parameters: { type: 'object', properties: {} } },
    }))
    const broken = {
      // No `type: "function"`: the live gateway refuses a body carrying this.
      function: { name: 'dsh_ops_shell', description: 'Run a command.', parameters: { type: 'object' } },
    }
    return [...healthy.slice(0, 4), broken, ...healthy.slice(4)]
  }

  const body = (): Record<string, unknown> => ({
    model: 'xopdeepseekv4pro',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    tools: toolsWithOneBroken(),
  })

  async function post(url: string, token: string, payload: unknown): Promise<number> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Host: '127.0.0.1' },
      body: JSON.stringify(payload),
    })
    await res.text()
    return res.status
  }

  afterEach(async () => {
    await new Promise<void>(resolve => gateway.close(() => resolve()))
  })

  it('finds the broken tool, drops it, and keeps the fix', async () => {
    const refusesWithoutType = (candidate: Record<string, unknown>): number | undefined => {
      const tools = Array.isArray(candidate.tools) ? candidate.tools : []
      return tools.some(tool => (tool as { type?: string }).type !== 'function') ? 400 : undefined
    }
    await startGateway(refusesWithoutType)
    const { url, token, warnings } = await startShim()

    expect(await post(url, token, body())).toBe(200)
    expect(warnings.join('\n')).toContain('dsh_ops_shell')

    const afterFirst = seen.length
    expect(await post(url, token, body())).toBe(200)
    // The learned fix applies up front, so the second request costs one send.
    expect(seen.length - afterFirst).toBe(1)
  })

  it('clamps an output budget the gateway refuses', async () => {
    await startGateway(candidate => (typeof candidate.max_tokens === 'number' && candidate.max_tokens > 8192 ? 400 : undefined))
    const { url, token, warnings } = await startShim()

    const payload = { model: 'xopdeepseekv4pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100000 }
    expect(await post(url, token, payload)).toBe(200)
    expect(warnings.join('\n')).toContain('max_tokens=100000')
    expect((seen.at(-1)?.max_tokens as number)).toBe(8192)
  })

  it('dumps the refused body so the shape can be inspected', async () => {
    const dir = join(tmpdir(), `astudio-dump-${process.pid}`)
    process.env.ASTUDIO_DUMP_FAILED_DIR = dir
    await startGateway(() => 400)
    const { url, token } = await startShim()

    expect(await post(url, token, body())).toBe(400)
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(0)
    const written = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as { trail: unknown[] }
    expect(written.trail.length).toBeGreaterThan(0)
    delete process.env.ASTUDIO_DUMP_FAILED_DIR
    rmSync(dir, { recursive: true, force: true })
  })
})
