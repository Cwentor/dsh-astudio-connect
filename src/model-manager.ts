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
  return { id, name, supportsImages: false, reasoning: { ...reasoningFor(raw) }, contextWindow, maxTokens }
}

/**
 * Parse a model-manager payload into catalog entries.
 *
 * Throws when the envelope reports a failure or when no row survives, so a
 * refresh cannot silently replace a good roster with an empty one.
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
  const rawModels = Array.isArray(data?.['models']) ? data['models'] : []
  const models: AStudioModelInfo[] = []
  for (const rawModel of rawModels) {
    const record = asRecord(rawModel)
    if (record === undefined) continue
    const model = parseModel(record as RawModel)
    if (model !== undefined) models.push(model)
  }
  if (models.length === 0) throw new Error('AStudio model catalog resolved to an empty list')
  return models
}

/**
 * Merge live entries over a fallback roster.
 *
 * The fallback's order and metadata win for ids the live catalog also lists —
 * the live document is the authority for budgets, but the compiled-in names
 * keep the picker stable. Live-only ids are appended with a minimal name.
 */
export function buildCatalogFromUpstream(
  live: readonly AStudioModelInfo[],
  fallback: readonly AStudioModelInfo[],
): AStudioModelInfo[] {
  const byId = new Map(live.map(model => [model.id, model]))
  const merged: AStudioModelInfo[] = []
  for (const entry of fallback) {
    const override = byId.get(entry.id)
    merged.push(override === undefined ? entry : override)
    byId.delete(entry.id)
  }
  for (const extra of byId.values()) merged.push(extra)
  return merged
}
