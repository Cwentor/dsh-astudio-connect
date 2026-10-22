/**
 * Refresh-path tests: the catalog must read AStudio's model-manager document
 * (the roster the AStudio UI shows), never the OpenAI-compatible
 * `/v1/models` discovery subset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioCatalog } from '../src/catalog.ts'
import { createAStudioUpstream } from '../src/upstream.ts'
import { DEFAULT_MODEL_MANAGER_BASE } from '../src/model-manager.ts'

const MANAGER_MODELS = [
  {
    slug: 'spark-x2.6-preview',
    display_name: 'Spark-X2.6-Preview',
    context_window: 262144,
    max_output_tokens: 100000,
    supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }],
  },
  { slug: 'xopglm52', display_name: 'GLM-5.2', context_window: 1048576, max_output_tokens: 100000 },
]

let server: Server
let base: string
let dir: string
let catalogPath: string
let requested: string[]

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      requested.push(`${req.method ?? ''} ${url}`)
      res.setHeader('Content-Type', 'application/json')
      // The model-manager document is the authoritative roster.
      if (url.endsWith('/models')) {
        res.end(JSON.stringify({ code: 0, message: 'success', data: { models: MANAGER_MODELS } }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

beforeEach(async () => {
  requested = []
  base = await startServer()
  dir = mkdtempSync(join(tmpdir(), 'astudio-refresh-'))
  catalogPath = join(dir, 'catalog.json')
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

function makeCatalog() {
  return createAStudioCatalog({
    upstream: createAStudioUpstream({ baseUrl: `${base}/v1` }),
    token: () => 'test-token-1234567890',
    modelBearerToken: () => 'model-bearer-token',
    modelManagerBaseUrl: base,
    catalogPath,
    identity: 'astudio-local',
  })
}

describe('catalog refresh through the model-manager endpoint', () => {
  it('reads the authoritative roster and keeps its budgets', async () => {
    const catalog = makeCatalog()
    await catalog.refresh()

    const models = catalog.current()
    const spark = models.find(model => model.id === 'spark-x2.6-preview')
    expect(spark).toBeDefined()
    expect(spark?.contextWindow).toBe(262144)
    expect(spark?.maxTokens).toBe(100000)
    expect(catalog.source()).toBe('live')
  })

  it('never falls back to the /v1/models discovery subset', async () => {
    const catalog = createAStudioCatalog({
      upstream: createAStudioUpstream({ baseUrl: `${base}/v1` }),
      token: () => 'test-token-1234567890',
      modelBearerToken: () => 'model-bearer-token',
      modelManagerBaseUrl: `${base}/api/v1/model-manager`,
      catalogPath,
      identity: 'astudio-local',
    })
    await catalog.refresh()
    expect(requested).toContain('GET /api/v1/model-manager/models')
    expect(requested.some(entry => entry.endsWith('/v1/models'))).toBe(false)
  })

  it('sends the model bearer token, not the chat token', async () => {
    const catalog = makeCatalog()
    await catalog.refresh()
    // A rejected token would leave the catalog with no roster at all.
    expect(catalog.source()).toBe('live')
  })

  it('persists the live roster so a later start can serve it', async () => {
    const catalog = makeCatalog()
    await catalog.refresh()
    expect(existsSync(catalogPath)).toBe(true)
    const saved = readFileSync(catalogPath, 'utf8')
    expect(saved).toContain('spark-x2.6-preview')
  })

  it('stays empty when the endpoint cannot be reached', async () => {
    const catalog = createAStudioCatalog({
      upstream: createAStudioUpstream({ baseUrl: `${base}/v1` }),
      token: () => 'test-token-1234567890',
      modelBearerToken: () => 'model-bearer-token',
      modelManagerBaseUrl: 'http://127.0.0.1:1',
      catalogPath,
      identity: 'astudio-local',
    })
    await catalog.refresh()
    // No built-in roster: an unreachable endpoint means no models, reported
    // as such rather than filled in from a compiled-in list.
    expect(catalog.source()).toBe('empty')
    expect(catalog.current()).toEqual([])
    expect(catalog.failure()).toBe('network-error')
  })

  it('does nothing when no model bearer token is available', async () => {
    const catalog = createAStudioCatalog({
      upstream: createAStudioUpstream({ baseUrl: `${base}/v1` }),
      token: () => 'test-token-1234567890',
      modelBearerToken: () => undefined,
      modelManagerBaseUrl: `${base}`,
      catalogPath,
      identity: 'astudio-local',
    })
    await catalog.refresh()
    expect(catalog.source()).toBe('empty')
    expect(catalog.failure()).toBe('no-model-token')
    expect(requested.length).toBe(0)
  })
})

describe('model-manager base URL default', () => {
  it('points at the production model-manager API', () => {
    expect(DEFAULT_MODEL_MANAGER_BASE).toContain('model-manager')
  })
})
