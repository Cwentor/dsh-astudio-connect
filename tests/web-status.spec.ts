import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerAStudioStatusRoute } from '../src/web-status.ts'
import type { AStudioStatusStore } from '../src/web-status.ts'
import type { AStudioCatalog, AStudioModelInfo } from '../src/catalog.ts'
import type { AStudioProbeStore } from '../src/probe-store.ts'

const MODELS: AStudioModelInfo[] = [
  { id: 'spark-x2.5', name: 'Spark X2.5', contextWindow: 131072, maxTokens: 8192 },
  { id: 'spark-x2.6-preview', name: 'Spark X2.6 Preview', contextWindow: 131072, maxTokens: 8192 },
]

function mockStore(state: 'signed-in' | 'signed-out'): AStudioStatusStore {
  return {
    resolve: () => state === 'signed-in' ? 'token-abc' : undefined,
    status: async () => state === 'signed-in'
      ? { state, configPath: 'config.toml', tokenLength: 10, hints: [] }
      : { state, configPath: 'config.toml', hints: ['sign in'] },
  }
}

function mockCatalog(): AStudioCatalog {
  return {
    current: () => MODELS,
    source: () => 'live',
    hiddenModelIds: () => ['spark-x2.6-preview'],
    refresh: async () => {},
    fetchedAtMs: () => Date.now(),
  }
}

function mockProbe(): AStudioProbeStore {
  return {
    get: (account, modelId) => account === 'astudio-local' && modelId === 'spark-x2.5'
      ? { account, modelId, validation: 'validating', efforts: ['low'], expiresAtMs: Date.now() + 60_000 }
      : undefined,
    put: async () => {},
    clear: async () => {},
  }
}

function createMockContext(): { ctx: Context; getRoute: () => { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined } {
  let route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined
  const ctx = {
    webServer: {
      register: (r: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        route = r
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, getRoute: () => route }
}

function mockResponse() {
  let statusCode = 0
  let body = ''
  const res = {
    writeHead: (code: number, _headers: Record<string, string>) => { statusCode = code },
    end: (payload?: string) => { body = payload ?? '' },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    body: () => body,
  }
}

function mockRequest(host: string): IncomingMessage {
  return { headers: { host } } as unknown as IncomingMessage
}

describe('registerAStudioStatusRoute', () => {
  it('serves auth, catalog, visibility, and probe sections', async () => {
    const { ctx, getRoute } = createMockContext()
    registerAStudioStatusRoute(ctx, { store: mockStore('signed-in'), catalog: mockCatalog(), probe: mockProbe() })
    const route = getRoute()
    expect(route?.kind).toBe('exact')
    expect(route?.path).toBe('/astudio/status')

    const response = mockResponse()
    await route?.handler(mockRequest('127.0.0.1'), response.res)

    expect(response.status()).toBe(200)
    const body = JSON.parse(response.body()) as {
      auth: { state: string; tokenLength?: number }
      catalog: { source: string; modelCount: number; models: Array<{ id: string }> }
      visibility: { hidden: string[] }
      probe: { account: string; results: Array<{ modelId: string; validation: string; efforts: string[]; expiresAtMs: number }> }
    }
    expect(body.auth.state).toBe('signed-in')
    expect(body.auth.tokenLength).toBe(10)
    expect(body.catalog.source).toBe('live')
    expect(body.catalog.modelCount).toBe(2)
    expect(body.catalog.models.map(m => m.id)).toEqual(['spark-x2.5', 'spark-x2.6-preview'])
    expect(body.visibility.hidden).toEqual(['spark-x2.6-preview'])
    expect(body.probe.account).toBe('astudio-local')
    expect(body.probe.results).toEqual([
      { modelId: 'spark-x2.5', validation: 'validating', efforts: ['low'], expiresAtMs: expect.any(Number) },
    ])
  })

  it('returns 403 for non-loopback Host', async () => {
    const { ctx, getRoute } = createMockContext()
    registerAStudioStatusRoute(ctx, { store: mockStore('signed-out'), catalog: mockCatalog() })
    const response = mockResponse()
    await getRoute()?.handler(mockRequest('evil.example.com'), response.res)
    expect(response.status()).toBe(403)
  })

  it('does not return the full token', async () => {
    const { ctx, getRoute } = createMockContext()
    registerAStudioStatusRoute(ctx, { store: mockStore('signed-in'), catalog: mockCatalog() })
    const response = mockResponse()
    await getRoute()?.handler(mockRequest('127.0.0.1'), response.res)
    expect(response.body()).not.toContain('token-abc')
  })

  it('returns an empty probe summary when no probe store is given', async () => {
    const { ctx, getRoute } = createMockContext()
    registerAStudioStatusRoute(ctx, { store: mockStore('signed-out'), catalog: mockCatalog() })
    const response = mockResponse()
    await getRoute()?.handler(mockRequest('localhost'), response.res)
    const body = JSON.parse(response.body()) as { probe: { account: string; results: unknown[] } }
    expect(body.probe).toEqual({ account: 'astudio-local', results: [] })
  })
})
