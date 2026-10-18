/**
 * AStudio pi-ai adapter. Assembles a PiAiAdapter that registers the
 * `astudio` provider into the DSH LLM seam, pointing at the loopback shim.
 *
 * @module dsh-astudio-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AStudioCatalog } from './catalog.ts'
import type { AStudioShim } from './shim.ts'

/** Provider route this bundle owns. */
export const ASTRO_PROVIDER = 'astudio'

/** Provider idle ceiling while one stream read is outstanding. */
export const ASTRO_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/** No per-token pricing is knowable; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Inert pi-ai auth plane — the shim shared secret is the only credential. */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-astudio-connect: the astudio route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** Constructor dependencies. */
export interface AStudioAdapterOptions {
  providerId?: string
  displayName?: string
  shim: AStudioShim
  catalog: AStudioCatalog
}

/** What {@link createAStudioAdapter} hands back. */
export interface AStudioAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

/**
 * Build the thinking-level map for a reasoning model.
 * maas-api reasoning models support low/high/max.
 */
function reasoningFields(info: { reasoning: boolean }): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  if (!info.reasoning) return { reasoning: false }
  const map: Record<ModelThinkingLevel, string | null> = {
    off: null, // maas-api reasoning models cannot disable thinking
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createAStudioAdapter(options: AStudioAdapterOptions): AStudioAdapter {
  const { shim, catalog } = options
  const providerId = options.providerId ?? ASTRO_PROVIDER
  const displayName = options.displayName ?? 'AStudio'

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'AStudio bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'AStudio' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: ASTRO_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-astudio-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new AStudioPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/** Override listModels to apply display-name formatting from the live catalog. */
export class AStudioPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: AStudioCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  private infoFor(model: string) {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      return info === undefined ? model : { ...model, name: info.name }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    return info === undefined ? resolved : { ...resolved, name: info.name }
  }
}
