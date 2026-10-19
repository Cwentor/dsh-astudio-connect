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

/**
 * The endpoint under test is the model-manager document, which is what the
 * AStudio UI renders and the only source that carries real budgets. Its
 * payload shape is `{ code, message, data: { models: [...] } }`.
 */
function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            models: [
              { slug: 'spark-x2.5', display_name: 'Spark-X2.5', context_window: 262144, max_output_tokens: 100000 },
              { slug: 'xopglm52', display_name: 'GLM-5.2', context_window: 1048576, max_output_tokens: 100000 },
              { slug: 'new-model-123', display_name: 'New Model', context_window: 65536, max_output_tokens: 8192 },
            ],
          },
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

function createCatalog(token = 'token', modelToken: string | undefined = 'model-token') {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => token,
    modelBearerToken: () => modelToken,
    modelManagerBaseUrl: `http://127.0.0.1:${port}`,
    catalogPath,
  })
}

function createNoTokenCatalog() {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => undefined,
    modelManagerBaseUrl: `http://127.0.0.1:${port}`,
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

  it('refresh loads the roster from the model-manager document', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const models = catalog.current()
    expect(models.some(m => m.id === 'spark-x2.5')).toBe(true)
    expect(models.some(m => m.id === 'xopglm52')).toBe(true)
    expect(models.some(m => m.id === 'new-model-123')).toBe(true)
    expect(catalog.source()).toBe('live')
    expect(catalog.fetchedAtMs()).toBeDefined()
  })

  it('keeps the built-in roster rather than dropping models the document omits', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    // The live document only lists three models; the rest of the compiled-in
    // roster must survive, because a missing row there does not mean the model
    // is uncallable. The one live-only id is appended, so the total is the
    // built-in roster plus that id.
    expect(catalog.current().length).toBe(DEFAULT_CATALOG.length + 1)
    expect(catalog.current().some(m => m.id === 'spark-x2.6-preview')).toBe(true)
    expect(catalog.current().some(m => m.id === 'astronclaw-auto')).toBe(true)
  })

  it('takes budgets from the live document', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const newModel = catalog.current().find(m => m.id === 'new-model-123')
    expect(newModel?.contextWindow).toBe(65536)
    expect(newModel?.maxTokens).toBe(8192)
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
          models: [{ id: 'saved-model', name: 'Saved Model', supportsImages: false, reasoning: { supports: false }, contextWindow: 131072, maxTokens: 8192 }],
        },
      },
    }), 'utf8')
    const failing = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      modelBearerToken: () => 'model-token',
      modelManagerBaseUrl: 'http://127.0.0.1:1',
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
      modelBearerToken: () => 'model-token',
      modelManagerBaseUrl: 'http://127.0.0.1:1',
      catalogPath,
    })
    await failing.refresh()
    expect(failing.current().length).toBe(DEFAULT_CATALOG.length)
    expect(failing.source()).toBe('fallback')
  })

  it('refresh merges live models over the built-in roster in order', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const ids = catalog.current().map(m => m.id)
    expect(ids[0]).toBe('spark-x2.5')
    expect(ids).toContain('xopglm52')
    expect(ids).toContain('new-model-123')
  })
})
