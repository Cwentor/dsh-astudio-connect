import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseModelManagerCatalog,
  modelManagerUrl,
  DEFAULT_MODEL_MANAGER_BASE,
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

  it('drops a level the gateway refuses for that model', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      data: {
        models: [{
          slug: 'spark-x2.6-4b',
          context_window: 1048576,
          max_output_tokens: 110000,
          // The roster advertises `max`, but maas-api answers it with 400.
          supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }, { effort: 'max' }],
        }],
      },
    })
    expect(models[0]?.reasoning?.supportedEfforts).toEqual(['high'])
    expect(models[0]?.reasoning?.canDisableThinking).toBe(true)
  })

  it('leaves a model outside the refusal table untouched', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      data: {
        models: [{
          slug: 'xopglm52',
          context_window: 1048576,
          max_output_tokens: 100000,
          supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }, { effort: 'max' }],
        }],
      },
    })
    expect(models[0]?.reasoning?.supportedEfforts).toEqual(['high', 'max'])
  })

  it('drops rows without a usable context window or output budget', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      data: { models: [{ slug: 'broken', context_window: 0, max_output_tokens: 0 }, { slug: 'ok', context_window: 1000, max_output_tokens: 100 }] },
    })
    expect(models.map(model => model.id)).toEqual(['ok'])
  })

  it('throws when every row is unusable', () => {
    // Rows arrived but none survived: that is a document this parser does not
    // understand, and must not be read as "upstream withdrew every model".
    expect(() => parseModelManagerCatalog({
      code: 0,
      data: { models: [{ slug: 'broken', context_window: 0, max_output_tokens: 0 }] },
    })).toThrow(/empty list/i)
  })

  it('throws when the envelope reports a failure', () => {
    expect(() => parseModelManagerCatalog({ code: 40001, message: 'no valid authorization' })).toThrow(/no valid authorization/i)
  })
})

describe('empty and malformed rosters', () => {
  it('parses an empty models array as an empty roster', () => {
    // Upstream saying "no models" is an answer, not a parse failure: the
    // catalog must be able to report an empty list truthfully.
    expect(parseModelManagerCatalog({ code: 0, message: 'success', data: { models: [] } })).toEqual([])
  })

  it('rejects a document with no models array at all', () => {
    // A missing/!array `models` is not the same statement as an empty one, and
    // must not be mistaken for "upstream withdrew every model".
    expect(() => parseModelManagerCatalog({ code: 0, message: 'success', data: {} })).toThrow(/models array/i)
    expect(() => parseModelManagerCatalog({ code: 0, message: 'success', data: { models: 'nope' } })).toThrow(/models array/i)
  })

  it('keeps the first row when a slug repeats', () => {
    const models = parseModelManagerCatalog({
      code: 0,
      message: 'success',
      data: {
        models: [
          { slug: 'spark-x2.5', display_name: 'First', context_window: 262144, max_output_tokens: 100000 },
          { slug: 'spark-x2.5', display_name: 'Second', context_window: 131072, max_output_tokens: 8192 },
        ],
      },
    })
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('First')
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
