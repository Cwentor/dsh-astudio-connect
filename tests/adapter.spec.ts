import { describe, it, expect } from 'vitest'
import { createAStudioAdapter, ASTRO_PROVIDER } from '../src/adapter.ts'
import { DEFAULT_CATALOG } from '../src/catalog.ts'
import type { AStudioShim } from '../src/shim.ts'
import type { AStudioCatalog } from '../src/catalog.ts'

// Mock shim
const mockShim: AStudioShim = {
  ready: Promise.resolve(),
  baseUrl: () => 'http://127.0.0.1:9999',
  token: () => 'mock-shared-secret',
  close: async () => {},
}

// Mock catalog
const mockCatalog: AStudioCatalog = {
  current: () => DEFAULT_CATALOG,
  refresh: async () => {},
  source: () => 'fallback',
  fetchedAtMs: () => undefined,
}

describe('createAStudioAdapter', () => {
  it('creates adapter with provider id astudio', () => {
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    expect(adapter).toBeDefined()
  })

  it('lists models from catalog', async () => {
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    const models = await adapter.listModels(ASTRO_PROVIDER)
    expect(models.length).toBe(DEFAULT_CATALOG.length)
    expect(models[0]?.id).toBe(DEFAULT_CATALOG[0]?.id)
  })

  it('resolves a model by id', async () => {
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    const resolved = await adapter.resolveModel(ASTRO_PROVIDER, 'spark-x2.5')
    expect(resolved.id).toBe('spark-x2.5')
  })

  it('includes reasoning models in the list', async () => {
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    const models = await adapter.listModels(ASTRO_PROVIDER)
    const spark = models.find(m => m.id === 'spark-x2.5')
    expect(spark).toBeDefined()
    expect(spark?.name).toBe('Spark X2.5')
  })

  it('includes non-reasoning models in the list', async () => {
    const { adapter } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    const models = await adapter.listModels(ASTRO_PROVIDER)
    const glm = models.find(m => m.id === 'xopglm52')
    expect(glm).toBeDefined()
    expect(glm?.name).toBe('GLM-5.2')
  })

  it('invalidate rebuilds profiles', () => {
    const { invalidate } = createAStudioAdapter({ shim: mockShim, catalog: mockCatalog })
    expect(invalidate).toBeDefined()
    invalidate() // Should not throw
  })
})
