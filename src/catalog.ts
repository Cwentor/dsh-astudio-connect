/**
 * AStudio model catalog. Holds the list of models available through maas-api
 * and provides a way to refresh from the upstream /v1/models endpoint.
 *
 * @module dsh-astudio-connect/catalog
 */

import type { AStudioUpstreamClient } from './upstream.ts'

/** Info for a single model. */
export interface AStudioModelInfo {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

/** The catalog interface. */
export interface AStudioCatalog {
  /** Get the current model list. */
  current(): readonly AStudioModelInfo[]
  /** Force a refresh from the upstream. */
  refresh(): Promise<void>
}

/** Options for creating a catalog. */
export interface AStudioCatalogOptions {
  upstream: AStudioUpstreamClient
  token: () => string | undefined
  /** Override the base URL for /v1/models (used by tests). */
  baseUrl?: string
}

/** Default built-in catalog — used when the upstream /v1/models is unavailable. */
export const DEFAULT_CATALOG: readonly AStudioModelInfo[] = [
  { id: 'spark-x2.5', name: 'Spark X2.5', reasoning: true, contextWindow: 131072, maxTokens: 8192 },
  { id: 'spark-x2.5-4b', name: 'Spark X2.5 4B', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
  { id: 'spark-x2.6-preview', name: 'Spark X2.6 Preview', reasoning: true, contextWindow: 131072, maxTokens: 8192 },
  { id: 'xopglm52', name: 'GLM-5.2', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
  { id: 'xopdeepseekv4pro', name: 'DeepSeek V4 Pro', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
  { id: 'xopdeepseekv4pro0813', name: 'DeepSeek V4 Pro 0813', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
  { id: 'xopdsv4flash0731in', name: 'DeepSeek V4 Flash', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
  { id: 'astronclaw-auto', name: 'AstronClaw Auto', reasoning: false, contextWindow: 131072, maxTokens: 8192 },
]

/**
 * Create a catalog backed by the upstream /v1/models endpoint.
 * Falls back to DEFAULT_CATALOG when the refresh fails.
 */
export function createAStudioCatalog(options: AStudioCatalogOptions): AStudioCatalog {
  let cached: readonly AStudioModelInfo[] = DEFAULT_CATALOG
  const baseUrl = options.baseUrl ?? 'https://maas-api.cn-huabei-1.xf-yun.com/v1'

  async function refresh(): Promise<void> {
    const token = options.token()
    if (token === undefined) return

    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return

      const data = (await res.json()) as { data?: Array<{ id: string }> }
      if (!data.data || data.data.length === 0) return

      // Map upstream model ids to catalog entries, keeping defaults for metadata.
      const knownIds = new Set(DEFAULT_CATALOG.map(m => m.id))
      const upstreamIds = new Set(data.data.map(d => d.id))
      cached = DEFAULT_CATALOG.filter(m => upstreamIds.has(m.id))

      // Add any upstream-only models with generic metadata.
      for (const up of data.data) {
        if (!knownIds.has(up.id)) {
          cached = [...cached, {
            id: up.id,
            name: up.id,
            reasoning: false,
            contextWindow: 131072,
            maxTokens: 8192,
          }]
        }
      }
    } catch {
      // Network error — keep the cached catalog.
    }
  }

  return {
    current: () => cached,
    refresh,
  }
}
