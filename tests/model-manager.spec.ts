import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseModelManagerCatalog,
  modelManagerUrl,
  DEFAULT_MODEL_MANAGER_BASE,
  buildCatalogFromUpstream,
} from '../src/model-manager.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** The real `/api/v1/model-manager/models` payload shape, trimmed to one row. */
const payload = {
  code: 0,
  message: 'success',
  data: {
    models: [
      {
        slug: 'spark-x2.6-preview',
        display_name: 'Spark-X2.6-Preview',
        context_window: 262144,
        max_output_tokens: 100000,
        auto_compact_token_limit: 170000,
        visibility: 'list',
        supported_in_api: true,
        supported_reasoning_levels: [
          { effort: 'none', description: '关闭思考' },
          { effort: 'high', description: '开启思考' },
        ],
      },
      {
        slug: 'xopglm52',
        display_name: 'GLM-5.2',
        context_window: 1048576,
        max_output_tokens: 100000,
        visibility: 'list',
        supported_in_api: true,
      },
    ],
  },
}

describe('modelManagerUrl', () => {
  it('appends the models path to the model-manager base', () => {
    expect(modelManagerUrl(DEFAULT_MODEL_MANAGER_BASE)).toBe(`${DEFAULT_MODEL_MANAGER_BASE}/models`)
  })

  it('tolerates a trailing slash on the base', () => {
    expect(modelManagerUrl(`${DEFAULT_MODEL_MANAGER_BASE}/`)).toBe(`${DEFAULT_MODEL_MANAGER_BASE}/models`)
  })
})

describe('parseModelManagerCatalog', () => {
  it('maps context_window and max_output_tokens onto catalog entries', () => {
    const models = parseModelManagerCatalog(payload)
    const spark = models.find(model => model.id === 'spark-x2.6-preview')
    expect(spark).toBeDefined()
    expect(spark?.contextWindow).toBe(262144)
    expect(spark?.maxTokens).toBe(100000)
  })

  it('uses display_name as the catalog name', () => {
    const models = parseModelManagerCatalog(payload)
    expect(models.find(model => model.id === 'xopglm52')?.name).toBe('GLM-5.2')
  })

  it('keeps only the reasoning efforts the upstream declares', () => {
    const models = parseModelManagerCatalog(payload)
    const spark = models.find(model => model.id === 'spark-x2.6-preview')
    expect(spark?.reasoning?.supports).toBe(true)
    expect(spark?.reasoning?.supportedEfforts).toEqual(['high'])
    expect(models.find(model => model.id === 'xopglm52')?.reasoning?.supports).toBe(false)
  })

  it('records that thinking can be disabled when upstream declares none', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      data: {
        models: [{
          slug: 'spark-x2.6-preview',
          context_window: 262144,
          max_output_tokens: 100000,
          supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }],
        }],
      },
    })
    const spark = models[0]
    // Upstream's "none" means thinking is switchable; it must not leak into
    // supportedEfforts as an effort value, but it must set the disable flag.
    expect(spark?.reasoning?.canDisableThinking).toBe(true)
    expect(spark?.reasoning?.supportedEfforts).toEqual(['high'])
  })

  it('drops rows without a usable context window or output budget', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      data: { models: [{ slug: 'broken', context_window: 0, max_output_tokens: 0 }, { slug: 'ok', context_window: 1000, max_output_tokens: 100 }] },
    })
    expect(models.map(model => model.id)).toEqual(['ok'])
  })

  it('throws when the catalog resolves to nothing', () => {
    expect(() => parseModelManagerCatalog({ code: 0, data: { models: [] } })).toThrow(/empty/i)
  })

  it('throws when the envelope reports a failure', () => {
    expect(() => parseModelManagerCatalog({ code: 40001, message: 'no valid authorization' })).toThrow(/no valid authorization/i)
  })
})

describe('buildCatalogFromUpstream', () => {
  it('keeps the known roster order and appends newly discovered ids', () => {
    const models = buildCatalogFromUpstream(
      [{ id: 'spark-x2.6-preview', name: 'Spark-X2.6-Preview', contextWindow: 262144, maxTokens: 100000 }],
      [
        { id: 'spark-x2.5', name: 'Spark X2.5', contextWindow: 262144, maxTokens: 100000 },
        { id: 'spark-x2.6-preview', name: 'Spark X2.6 Preview', contextWindow: 131072, maxTokens: 8192 },
        { id: 'brand-new', name: 'brand-new', contextWindow: 131072, maxTokens: 8192 },
      ],
    )
    expect(models.map(model => model.id)).toEqual(['spark-x2.5', 'spark-x2.6-preview', 'brand-new'])
    expect(models.find(model => model.id === 'spark-x2.6-preview')?.contextWindow).toBe(262144)
  })
})

describe('captured payload fixture', () => {
  it('parses the checked-in real payload without touching the network', () => {
    const raw = readFileSync(join(here, 'fixtures', 'model-manager-models.json'), 'utf8')
    const models = parseModelManagerCatalog(JSON.parse(raw))
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
  })
})
