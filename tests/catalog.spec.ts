import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'

let server: Server
let port: number
let catalogDir: string
let catalogPath: string

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

beforeEach(() => {
  catalogDir = mkdtempSync(join(tmpdir(), 'astudio-catalog-'))
  catalogPath = join(catalogDir, 'catalog.json')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function createCatalog(token = 'token') {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => token,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    catalogPath,
  })
}

function createNoTokenCatalog() {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => undefined,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    catalogPath,
  })
}

describe('createAStudioCatalog', () => {
  it('starts with DEFAULT_CATALOG and fallback source', () => {
    const catalog = createCatalog()
    const models = catalog.current()
    expect(models.length).toBe(DEFAULT_CATALOG.length)
    expect(models[0]?.id).toBe(DEFAULT_CATALOG[0]?.id)
    expect(catalog.source()).toBe('fallback')
    expect(catalog.fetchedAtMs()).toBeUndefined()
  })

  it('refresh loads models from upstream /v1/models and records live source', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const models = catalog.current()
    expect(models.some(m => m.id === 'spark-x2.5')).toBe(true)
    expect(models.some(m => m.id === 'xopglm52')).toBe(true)
    expect(models.some(m => m.id === 'new-model-123')).toBe(true)
    expect(models.some(m => m.id === 'spark-x2.6-preview')).toBe(false)
    expect(catalog.source()).toBe('live')
    expect(catalog.fetchedAtMs()).toBeDefined()
  })

  it('refresh keeps cached data on failure and no token', async () => {
    const catalog = createNoTokenCatalog()
    await catalog.refresh()
    const models = catalog.current()
    expect(models.length).toBe(DEFAULT_CATALOG.length)
    expect(catalog.source()).toBe('fallback')
  })

  it('refresh falls back to saved snapshot after a later failed fetch', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const live = catalog.current()

    // Save a known snapshot directly, then fail the next fetch by pointing
    // at a non-listening port.
    catalogDir = mkdtempSync(join(tmpdir(), 'astudio-catalog-'))
    catalogPath = join(catalogDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      catalogs: {
        'astudio-local': {
          fetchedAtMs: Date.now(),
          models: [{ id: 'saved-model', name: 'Saved Model', reasoning: false, contextWindow: 131072, maxTokens: 8192 }],
        },
      },
    }), 'utf8')
    const failing = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: 'http://127.0.0.1:1/v1',
      catalogPath,
    })
    await failing.refresh()
    expect(failing.current()).toHaveLength(1)
    expect(failing.current()[0]?.id).toBe('saved-model')
    expect(failing.source()).toBe('saved')
    expect(failing.fetchedAtMs()).toBeDefined()
    expect(live[0]?.id).toBeDefined()
  })

  it('refresh keeps fallback when no saved snapshot exists and fetch fails', async () => {
    const catalog = createCatalog()
    catalogDir = mkdtempSync(join(tmpdir(), 'astudio-catalog-'))
    catalogPath = join(catalogDir, 'catalog.json')
    const failing = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      baseUrl: 'http://127.0.0.1:1/v1',
      catalogPath,
    })
    await failing.refresh()
    expect(failing.current().length).toBe(DEFAULT_CATALOG.length)
    expect(failing.source()).toBe('fallback')
  })

  it('refresh filters to upstream models and adds unknown ones', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const models = catalog.current()
    expect(models.length).toBe(3)
    const ids = models.map(m => m.id)
    expect(ids).toContain('spark-x2.5')
    expect(ids).toContain('xopglm52')
    expect(ids).toContain('new-model-123')
  })
})
