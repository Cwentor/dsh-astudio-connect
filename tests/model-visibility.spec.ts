import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioCatalog } from '../src/catalog.ts'
import { createAStudioVisibilityStore } from '../src/visibility-store.ts'
import { createAStudioAdapter, ASTRO_PROVIDER } from '../src/adapter.ts'
import { createAStudioShim } from '../src/shim.ts'
import type { AStudioShim } from '../src/shim.ts'
import type { AStudioCatalog } from '../src/catalog.ts'
import { SAMPLE_MODELS } from './support/models.ts'

let dir: string
let catalogPath: string
let visibilityPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'astudio-visibility-'))
  catalogPath = join(dir, 'catalog.json')
  visibilityPath = join(dir, 'visibility.json')
  // The plugin ships no roster, so a test that needs models has to supply an
  // upstream answer. A saved snapshot is that: the last successful fetch, not
  // a built-in list.
  writeFileSync(catalogPath, JSON.stringify({
    version: 2,
    catalogs: { 'astudio-local': { fetchedAtMs: Date.now(), models: SAMPLE_MODELS } },
  }), 'utf8')
})

describe('AStudio visibility store', () => {
  it('saves and reads hidden model ids', async () => {
    const store = createAStudioVisibilityStore(visibilityPath)
    await store.setVisible('astudio-local', 'xopglm52', false)
    await store.setVisible('astudio-local', 'spark-x2.5', true)
    const hidden = await store.hidden('astudio-local')
    expect(hidden).toContain('xopglm52')
    expect(hidden).not.toContain('spark-x2.5')
  })
})

describe('catalog visibility', () => {
  it('exposes hidden ids separately from the full catalog', async () => {
    const store = createAStudioVisibilityStore(visibilityPath)
    await store.setVisible('astudio-local', 'xopglm52', false)
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      modelManagerBaseUrl: 'http://127.0.0.1:1',
      catalogPath,
      identity: 'astudio-local',
      visibility: store,
    })
    await catalog.refresh()
    expect(catalog.current().some(m => m.id === 'xopglm52')).toBe(true)
    expect(catalog.hiddenModelIds()).toContain('xopglm52')
  })
})

const mockShim: AStudioShim = {
  ready: Promise.resolve(),
  baseUrl: () => 'http://127.0.0.1:9999',
  token: () => 'mock-shared-secret',
  close: async () => {},
}

function mockCatalogWithVisibility(hidden: string[]): AStudioCatalog {
  return {
    current: () => SAMPLE_MODELS,
    refresh: async () => {},
    source: () => 'saved',
    fetchedAtMs: () => Date.now(),
    hiddenModelIds: () => hidden,
    failure: () => 'no-model-token',
  }
}

describe('shim visibility filtering', () => {
  it('excludes hidden models from /v1/models while keeping full catalog intact', async () => {
    const visibility = createAStudioVisibilityStore(visibilityPath)
    await visibility.setVisible('astudio-local', 'xopglm52', false)
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => 'token',
      modelManagerBaseUrl: 'http://127.0.0.1:1',
      catalogPath,
      identity: 'astudio-local',
      visibility,
    })
    await catalog.refresh()
    const shim = createAStudioShim({
      store: { resolve: () => 'token' },
      upstream: { chat: async () => { throw new Error('not used') } },
      catalog,
      logger: { warn: () => {}, error: () => {} },
    })
    await shim.ready
    try {
      const res = await fetch(`${shim.baseUrl()}/v1/models`, {
        headers: { Authorization: `Bearer ${shim.token()}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Array<{ id: string }> }
      expect(body.data.some(m => m.id === 'xopglm52')).toBe(false)
      expect(body.data.some(m => m.id === 'spark-x2.5')).toBe(true)
      expect(catalog.current().some(m => m.id === 'xopglm52')).toBe(true)
    } finally {
      await shim.close()
    }
  })
})

describe('adapter visibility filtering', () => {
  it('lists only visible models but still resolves hidden models', async () => {
    const catalog = mockCatalogWithVisibility(['xopglm52'])
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog })
    const models = await adapter.listModels(ASTRO_PROVIDER)
    expect(models.some(m => m.id === 'xopglm52')).toBe(false)
    expect(models.some(m => m.id === 'spark-x2.5')).toBe(true)
    const resolved = await adapter.resolveModel(ASTRO_PROVIDER, 'xopglm52')
    expect(resolved.id).toBe('xopglm52')
  })
})
