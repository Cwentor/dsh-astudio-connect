import { describe, it, expect } from 'vitest'
import { createAStudioAdapter, ASTRO_PROVIDER, reasoningFields, toPiModel } from '../src/adapter.ts'
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
  hiddenModelIds: () => [],
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

describe('adapter model metadata', () => {
  it('maps declared reasoning efforts', () => {
    const info = {
      id: 'img-model',
      name: 'Img Model',
      supportsImages: true,
      reasoning: { supports: true, supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false },
      contextWindow: 1000,
      maxTokens: 100,
    }
    const { reasoning, thinkingLevelMap } = reasoningFields(info)
    expect(reasoning).toBe(true)
    expect(thinkingLevelMap?.low).toBe('low')
    expect(thinkingLevelMap?.high).toBe('high')
    expect(thinkingLevelMap?.max).toBe('max')
    expect(thinkingLevelMap?.off).toBeNull()
  })

  it('does not offer reasoning control for undeclared or unsupported models', () => {
    expect(reasoningFields({ id: 'x', name: 'X', supportsImages: false, reasoning: { supports: false }, contextWindow: 1, maxTokens: 1 }).reasoning).toBe(false)
    expect(reasoningFields({ id: 'y', name: 'Y', supportsImages: false, reasoning: { supports: true }, contextWindow: 1, maxTokens: 1 }).reasoning).toBe(false)
  })

  it('maps a switchable model to the wire value for thinking off', () => {
    // AStudio declares "none" for switchable models, which the catalog layer
    // turns into canDisableThinking. The map value is sent verbatim as
    // `reasoning_effort`, and upstream's word for it is `none`: a literal
    // `off` is refused by maas-api with 10005.
    const info = {
      id: 'spark-x2.6-preview',
      name: 'Spark-X2.6-Preview',
      supportsImages: false,
      reasoning: { supports: true, supportedEfforts: ['high'], canDisableThinking: true },
      contextWindow: 262144,
      maxTokens: 100000,
    }
    const { reasoning, thinkingLevelMap } = reasoningFields(info)
    expect(reasoning).toBe(true)
    expect(thinkingLevelMap?.off).toBe('none')
    expect(thinkingLevelMap?.high).toBe('high')
    expect(thinkingLevelMap?.max).toBeNull()
  })

  it('sets image input only when the catalog declares supportsImages', () => {
    const image = toPiModel({ id: 'img', name: 'Img', supportsImages: true, contextWindow: 1000, maxTokens: 100 }, 'http://127.0.0.1:1/v1', 'astudio')
    const text = toPiModel({ id: 'txt', name: 'Txt', supportsImages: false, contextWindow: 1000, maxTokens: 100 }, 'http://127.0.0.1:1/v1', 'astudio')
    expect(image.input).toEqual(['text', 'image'])
    expect(text.input).toEqual(['text'])
  })
})
