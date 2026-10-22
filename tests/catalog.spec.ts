import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createAStudioCatalog } from '../src/catalog.ts'

/** What the fake model-manager answers on the next request. */
type ServerMode = 'live' | 'empty' | 'bad-shape' | 'http-error'

let server: Server
let port: number
let catalogPath: string
let mode: ServerMode = 'live'

/**
 * The endpoint under test is the model-manager document, which is what the
 * AStudio UI renders and the only source of truth for the roster. Its payload
 * shape is `{ code, message, data: { models: [...] } }`.
 */
function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url !== '/models') {
        res.writeHead(404)
        res.end()
        return
      }
      if (mode === 'http-error') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 50000, message: 'upstream is down' }))
        return
      }
      if (mode === 'bad-shape') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, message: 'success', data: {} }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          models: mode === 'empty'
            ? []
            : [
                { slug: 'spark-x2.5', display_name: 'Spark-X2.5', context_window: 262144, max_output_tokens: 100000 },
                { slug: 'xopglm52', display_name: 'GLM-5.2', context_window: 1048576, max_output_tokens: 100000 },
                { slug: 'new-model-123', display_name: 'New Model', context_window: 65536, max_output_tokens: 8192 },
              ],
        },
      }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

beforeAll(async () => {
  port = await startServer()
})

beforeEach(() => {
  mode = 'live'
  catalogPath = join(mkdtempSync(join(tmpdir(), 'astudio-catalog-')), 'catalog.json')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function createCatalog(options: { modelToken?: string | undefined, baseUrl?: string } = {}) {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => 'token',
    // `modelToken: undefined` is a case under test, so presence of the key —
    // not its value — decides whether the default applies.
    modelBearerToken: () => 'modelToken' in options ? options.modelToken : 'model-token',
    modelManagerBaseUrl: options.baseUrl ?? `http://127.0.0.1:${port}`,
    catalogPath,
  })
}

/** Read the models a snapshot holds for the default identity, if any. */
function savedModels(): unknown[] | undefined {
  try {
    const file = JSON.parse(readFileSync(catalogPath, 'utf8')) as { catalogs: Record<string, { models: unknown[] }> }
    return file.catalogs['astudio-local']?.models
  } catch {
    return undefined
  }
}

describe('createAStudioCatalog', () => {
  it('starts with no models at all — there is no built-in roster', () => {
    const catalog = createCatalog()
    expect(catalog.current()).toEqual([])
    expect(catalog.source()).toBe('empty')
    expect(catalog.fetchedAtMs()).toBeUndefined()
    // Nothing has been asked yet, so nothing has failed either.
    expect(catalog.failure()).toBeUndefined()
  })

  it('lists exactly what upstream returns, and nothing else', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.current().map(m => m.id)).toEqual(['spark-x2.5', 'xopglm52', 'new-model-123'])
    expect(catalog.source()).toBe('live')
    expect(catalog.failure()).toBeUndefined()
    expect(catalog.fetchedAtMs()).toBeDefined()
  })

  it('takes budgets from the upstream document', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    const model = catalog.current().find(m => m.id === 'new-model-123')
    expect(model?.contextWindow).toBe(65536)
    expect(model?.maxTokens).toBe(8192)
  })

  it('reports an empty roster when upstream lists no models', async () => {
    mode = 'empty'
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.current()).toEqual([])
    expect(catalog.source()).toBe('empty')
    expect(catalog.failure()).toBe('empty-roster')
  })

  it('records an empty upstream answer instead of reviving older models', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.current().length).toBe(3)

    // Upstream now says "no models". That answer is persisted as-is, so a
    // later failed refresh cannot resurrect the three rows from before.
    mode = 'empty'
    await catalog.refresh()
    expect(savedModels()).toEqual([])

    mode = 'http-error'
    const later = createCatalog({ baseUrl: `http://127.0.0.1:${port}` })
    await later.refresh()
    expect(later.current()).toEqual([])
    expect(later.source()).toBe('empty')
  })

  it('reports a missing model token rather than inventing a roster', async () => {
    const catalog = createCatalog({ modelToken: undefined })
    await catalog.refresh()
    expect(catalog.current()).toEqual([])
    expect(catalog.source()).toBe('empty')
    expect(catalog.failure()).toBe('no-model-token')
  })

  it('falls back to the last saved upstream snapshot when the fetch fails', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.current().length).toBe(3)

    const offline = createCatalog({ baseUrl: 'http://127.0.0.1:1' })
    await offline.refresh()
    expect(offline.current().map(m => m.id)).toEqual(['spark-x2.5', 'xopglm52', 'new-model-123'])
    expect(offline.source()).toBe('saved')
    expect(offline.failure()).toBe('network-error')
    expect(offline.fetchedAtMs()).toBeDefined()
  })

  it('stays empty when the fetch fails and no snapshot exists', async () => {
    const offline = createCatalog({ baseUrl: 'http://127.0.0.1:1' })
    await offline.refresh()
    expect(offline.current()).toEqual([])
    expect(offline.source()).toBe('empty')
    expect(offline.failure()).toBe('network-error')
  })

  it('treats a malformed document as a failure, not as an empty roster', async () => {
    mode = 'bad-shape'
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.current()).toEqual([])
    expect(catalog.source()).toBe('empty')
    expect(catalog.failure()).toBe('invalid-payload')
    // Nothing authoritative arrived, so no snapshot was written.
    expect(savedModels()).toBeUndefined()
  })

  it('keeps a live roster on screen when one poll fails', async () => {
    const catalog = createCatalog()
    await catalog.refresh()
    expect(catalog.source()).toBe('live')

    mode = 'http-error'
    await catalog.refresh()
    // A single failed poll must not blank the picker mid-session.
    expect(catalog.current().length).toBe(3)
    expect(catalog.source()).toBe('live')
    expect(catalog.failure()).toBe('http-error')
  })
})
