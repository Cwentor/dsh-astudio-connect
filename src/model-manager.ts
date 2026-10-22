/**
 * AStudio's authoritative model catalog endpoint.
 *
 * AStudio serves its model roster, with per-model context and output budgets,
 * from `GET {base}/models` on the model-manager API. Its own runtime reads the
 * same document, which is why this — not `GET /v1/models` on the chat host —
 * is the roster the AStudio UI shows.
 *
 * `GET /v1/models` and `GET /v2/models` are OpenAI-compatible discovery
 * endpoints on a different host; they answer with a smaller, stale subset.
 *
 * @module dsh-astudio-connect/model-manager
 */

import type { AStudioModelInfo } from './catalog.ts'

/** Production model-manager API base. */
export const DEFAULT_MODEL_MANAGER_BASE = 'https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager'

/** Build the catalog URL from a model-manager base. */
export function modelManagerUrl(base: string = DEFAULT_MODEL_MANAGER_BASE): string {
  return `${base.replace(/\/+$/u, '')}/models`
}

/** One raw model row from the model-manager document. */
interface RawModel {
  slug?: unknown
  display_name?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
  supported_in_api?: unknown
  visibility?: unknown
  supported_reasoning_levels?: unknown
}

/** The envelope the model-manager endpoint answers with. */
interface RawEnvelope {
  code?: unknown
  message?: unknown
  data?: unknown
}

/** Thinking levels this plugin maps onto pi-ai's scale. */
const MAPPED_EFFORTS = new Set(['low', 'medium', 'high', 'max', 'xhigh'])

/**
 * Levels the gateway refuses for a model even though the roster lists them.
 *
 * `spark-x2.6-4b` is advertised with `max`, but maas-api answers
 * `reasoning_effort: "max"` for it with `400 invalid request` (measured
 * 2026-10-23), and `minimal` / `medium` are refused too. A level that cannot
 * be sent is worse than an absent one: the picker offers it, the request fails
 * outright, and only the retry path recovers. The roster is the primary source
 * for these ladders, not an infallible one, so this is the one correction the
 * catalog layer applies on top of it.
 */
const REFUSED_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'spark-x2.5-4b': ['minimal', 'medium', 'max'],
  'spark-x2.6-4b': ['minimal', 'medium', 'max'],
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Extract the declared reasoning efforts a model actually supports. */
function reasoningFor(raw: RawModel): NonNullable<AStudioModelInfo['reasoning']> {
  const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : []
  const efforts = new Set<string>()
  let canDisableThinking = false
  for (const level of levels) {
    const record = asRecord(level)
    const effort = typeof record?.['effort'] === 'string' ? record['effort'] : undefined
    if (effort === undefined) continue
    // Upstream's "none" means thinking can be switched off; it is a capability
    // flag, not an effort level, so it never enters supportedEfforts.
    if (effort === 'none') {
      canDisableThinking = true
      continue
    }
    if (MAPPED_EFFORTS.has(effort)) efforts.add(effort)
  }
  if (efforts.size === 0 && !canDisableThinking) return { supports: false }
  return { supports: true, supportedEfforts: [...efforts], canDisableThinking }
}

/** Drop the efforts the gateway is known to refuse for this model id. */
function withoutRefusedEfforts(
  id: string,
  reasoning: NonNullable<AStudioModelInfo['reasoning']>,
): NonNullable<AStudioModelInfo['reasoning']> {
  const refused = REFUSED_EFFORTS[id]
  const efforts = reasoning.supportedEfforts
  if (refused === undefined || efforts === undefined) return reasoning
  const kept = efforts.filter(effort => !refused.includes(effort))
  if (kept.length === efforts.length) return reasoning
  if (kept.length === 0 && reasoning.canDisableThinking !== true) return { supports: false }
  return { ...reasoning, supportedEfforts: kept }
}

/** Parse one raw model row, or undefined when it carries no usable budgets. */
function parseModel(raw: RawModel): AStudioModelInfo | undefined {
  const id = typeof raw.slug === 'string' ? raw.slug : ''
  if (id === '') return undefined
  if (raw.supported_in_api === false) return undefined
  if (typeof raw.visibility === 'string' && raw.visibility !== 'list') return undefined

  const contextWindow = positiveInteger(raw.context_window)
  const maxTokens = positiveInteger(raw.max_output_tokens)
  if (contextWindow === undefined || maxTokens === undefined) return undefined

  const name = typeof raw.display_name === 'string' && raw.display_name !== '' ? raw.display_name : id
  return { id, name, supportsImages: false, reasoning: withoutRefusedEfforts(id, { ...reasoningFor(raw) }), contextWindow, maxTokens }
}

/**
 * Parse a model-manager payload into catalog entries.
 *
 * Two "empty" outcomes are kept apart deliberately:
 *
 * - `data.models` is an empty array — upstream is saying this account has no
 *   models. That is a real answer and parses to `[]`, which the catalog layer
 *   surfaces as "no models available".
 * - `data.models` is missing or not an array, or every row is unusable —
 *   the document is not describing a roster, so this throws. A malformed
 *   document must not be mistaken for an empty one, or a bad deploy upstream
 *   would quietly wipe a good saved snapshot.
 *
 * Rows are deduplicated by id, first occurrence winning, because the restored
 * catalog is fed straight to a picker that keys rows by id.
 */
export function parseModelManagerCatalog(payload: unknown): AStudioModelInfo[] {
  const envelope = asRecord(payload)
  if (envelope === undefined) throw new Error('AStudio model catalog was not an object')

  const code = envelope['code']
  if (code !== undefined && code !== 0 && code !== '0') {
    const message = typeof envelope['message'] === 'string' ? envelope['message'] : 'unknown error'
    throw new Error(`AStudio model catalog request failed: ${message}`)
  }

  const data = asRecord(envelope['data'])
  const rawModels = data?.['models']
  if (!Array.isArray(rawModels)) throw new Error('AStudio model catalog carried no models array')

  const models: AStudioModelInfo[] = []
  const seen = new Set<string>()
  for (const rawModel of rawModels) {
    const record = asRecord(rawModel)
    if (record === undefined) continue
    const model = parseModel(record as RawModel)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  // An empty input array is an answer; a non-empty input that survived nothing
  // is a document this parser does not understand, and must not be read as
  // "upstream withdrew every model".
  if (rawModels.length > 0 && models.length === 0) throw new Error('AStudio model catalog resolved to an empty list')
  return models
}
