/**
 * AStudio model catalog. Holds the list of models available through maas-api
 * and provides a way to refresh from the upstream /v1/models endpoint.
 *
 * @module dsh-astudio-connect/catalog
 */

import type { AStudioUpstreamClient } from './upstream.ts'
import { ASTRO_LOCAL_IDENTITY } from './identity.ts'
import { astudioCatalogPath, writeCatalogSnapshot, readCatalogSnapshot } from './catalog-store.ts'
import { DEFAULT_MODEL_MANAGER_BASE, modelManagerUrl, parseModelManagerCatalog, buildCatalogFromUpstream } from './model-manager.ts'
import type { AStudioVisibilityStore } from './visibility-store.ts'

/** Info for a single model. */
export interface AStudioModelInfo {
  id: string
  name: string
  supportsImages?: boolean
  reasoning?: {
    supports?: boolean
    supportedEfforts?: string[]
    canDisableThinking?: boolean
  }
  contextWindow: number
  maxTokens: number
}

/** The catalog interface. */
export interface AStudioCatalog {
  /** Get the current model list. */
  current(): readonly AStudioModelInfo[]
  /** Force a refresh from the upstream. */
  refresh(): Promise<void>
  /** Where the current models came from. */
  source(): 'live' | 'saved' | 'fallback'
  /** When the current models were fetched, for live and saved sources. */
  fetchedAtMs(): number | undefined
  /** Model ids hidden by the current identity. */
  hiddenModelIds(): readonly string[]
}

/** Options for creating a catalog. */
export interface AStudioCatalogOptions {
  upstream: AStudioUpstreamClient
  token: () => string | undefined
  /**
   * Resolve the model-manager credential. AStudio issues this separately from
   * the chat token (it lands in `astron-session.json` as `modelBearerToken`).
   */
  modelBearerToken?: () => string | undefined
  /** Override the model-manager API base (used by tests). */
  modelManagerBaseUrl?: string
  /** Override the identity used for catalog persistence. */
  identity?: string
  /** Override the catalog snapshot path. */
  catalogPath?: string
  /** Visibility store used to report hidden model ids. */
  visibility?: AStudioVisibilityStore
}

/** Default built-in catalog — used when the upstream /v1/models is unavailable. */
export const DEFAULT_CATALOG: readonly AStudioModelInfo[] = [
  { id: 'spark-x2.5', name: 'Spark X2.5', supportsImages: false, reasoning: { supports: true, supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false }, contextWindow: 262144, maxTokens: 100000 },
  { id: 'spark-x2.5-4b', name: 'Spark X2.5 4B', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 110000 },
  { id: 'spark-x2.6-preview', name: 'Spark X2.6 Preview', supportsImages: false, reasoning: { supports: true, supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false }, contextWindow: 262144, maxTokens: 100000 },
  { id: 'xopglm52', name: 'GLM-5.2', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 100000 },
  { id: 'xopdeepseekv4pro', name: 'DeepSeek V4 Pro', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 100000 },
  { id: 'xopdeepseekv4pro0813', name: 'DeepSeek V4 Pro 0813', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 100000 },
  { id: 'xopdsv4flash0731in', name: 'DeepSeek V4 Flash', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 100000 },
  { id: 'astronclaw-auto', name: 'AstronClaw Auto', supportsImages: false, reasoning: { supports: false }, contextWindow: 1048576, maxTokens: 100000 },
]

/**
 * Create a catalog backed by the upstream /v1/models endpoint.
 * Falls back to DEFAULT_CATALOG when the refresh fails.
 */
export function createAStudioCatalog(options: AStudioCatalogOptions): AStudioCatalog {
  let cached: readonly AStudioModelInfo[] = DEFAULT_CATALOG
  let source: 'live' | 'saved' | 'fallback' = 'fallback'
  let fetchedAtMs: number | undefined
  const modelManagerBase = options.modelManagerBaseUrl ?? DEFAULT_MODEL_MANAGER_BASE
  const identity = options.identity ?? ASTRO_LOCAL_IDENTITY
  const catalogPath = options.catalogPath ?? astudioCatalogPath()
  const visibility = options.visibility

  async function loadSaved(): Promise<void> {
    const snapshot = await readCatalogSnapshot(catalogPath, identity)
    if (snapshot === undefined) return
    cached = snapshot.models
    source = 'saved'
    fetchedAtMs = snapshot.fetchedAtMs
  }

  /**
   * Fetch the roster from AStudio's model-manager API.
   *
   * That document is what the AStudio UI itself renders, and it carries the
   * real per-model context and output budgets. The OpenAI-compatible
   * `/v1/models` endpoint is deliberately not used: it answers with a smaller,
   * stale subset, which would drop models that are in fact callable.
   */
  async function fetchLive(): Promise<readonly AStudioModelInfo[] | undefined> {
    const modelToken = options.modelBearerToken?.()
    if (modelToken === undefined || modelToken === '') return undefined
    try {
      const res = await fetch(modelManagerUrl(modelManagerBase), {
        headers: { Authorization: `Bearer ${modelToken}`, Accept: 'application/json' },
      })
      if (!res.ok) return undefined
      const payload: unknown = await res.json()
      const live = parseModelManagerCatalog(payload)
      return buildCatalogFromUpstream(live, DEFAULT_CATALOG)
    } catch {
      return undefined
    }
  }

  async function refresh(): Promise<void> {
    const fetched = await fetchLive()

    if (fetched !== undefined) {
      await writeCatalogSnapshot(catalogPath, identity, fetched, Date.now())
      cached = fetched
      source = 'live'
      fetchedAtMs = Date.now()
      return
    }

    const hadFallback = source === 'fallback'
    await loadSaved()
    if (hadFallback) return
  }

  return {
    current: () => cached,
    refresh,
    source: () => source,
    fetchedAtMs: () => fetchedAtMs,
    hiddenModelIds: () => visibility === undefined ? [] : [...(visibility.hidden(identity) ?? [])],
  }
}
