import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'

let server: Server
let port: number

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'spark-x2.5', object: 'model', created: 0, owned_by: 'xunfei' },
            { id: 'xopglm52', object: 'model', created: 0, owned_by: 'xunfei' },
            { id: 'new-model-123', object: 'model', created: 0, owned_by: 'xunfei' },
          ],
        }))
        return
      }
      res.writeHead(404)
      res.end()
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

describe('createAStudioCatalog', () => {
  it('starts with DEFAULT_CATALOG', () => {
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    const models = catalog.current()
    expect(models.length).toBe(DEFAULT_CATALOG.length)
    expect(models[0]?.id).toBe(DEFAULT_CATALOG[0]?.id)
  })

  it('refresh loads models from upstream /v1/models', async () => {
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    await catalog.refresh()
    const models = catalog.current()
    // Should contain spark-x2.5 and xopglm52 (known) + new-model-123 (unknown)
    expect(models.some(m => m.id === 'spark-x2.5')).toBe(true)
    expect(models.some(m => m.id === 'xopglm52')).toBe(true)
    expect(models.some(m => m.id === 'new-model-123')).toBe(true)
    // Should NOT contain spark-x2.6-preview (not in upstream response)
    expect(models.some(m => m.id === 'spark-x2.6-preview')).toBe(false)
  })

  it('refresh keeps cached data on failure', async () => {
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => undefined, // No token → refresh skips
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    await catalog.refresh()
    const models = catalog.current()
    // Should still have DEFAULT_CATALOG since refresh was skipped
    expect(models.length).toBe(DEFAULT_CATALOG.length)
  })

  it('refresh handles network errors gracefully', async () => {
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: 'http://127.0.0.1:1/v1', // Port 1 is not listening
    })
    await catalog.refresh()
    const models = catalog.current()
    expect(models.length).toBe(DEFAULT_CATALOG.length)
  })

  it('refresh filters to upstream models and adds unknown ones', async () => {
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    await catalog.refresh()
    const models = catalog.current()
    // Known models from upstream + new-model-123
    expect(models.length).toBe(3)
    const ids = models.map(m => m.id)
    expect(ids).toContain('spark-x2.5')
    expect(ids).toContain('xopglm52')
    expect(ids).toContain('new-model-123')
  })
})
