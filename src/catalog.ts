/**
 * AStudio model catalog. Holds the list of models available through maas-api
 * and refreshes it from AStudio's model-manager endpoint.
 *
 * There is deliberately **no compiled-in roster**. A model that this plugin
 * was not told about by upstream is not offered: the picker showing a model
 * the account cannot call is worse than the picker showing nothing, and an
 * empty roster is a fact worth reporting rather than papering over. So when
 * upstream answers with no models — or cannot be reached at all — `current()`
 * is empty and `source()` says `empty`; nothing is substituted.
 *
 * @module dsh-astudio-connect/catalog
 */

import type { AStudioUpstreamClient } from './upstream.ts'
import { ASTRO_LOCAL_IDENTITY } from './identity.ts'
import { astudioCatalogPath, writeCatalogSnapshot, readCatalogSnapshot } from './catalog-store.ts'
import { DEFAULT_MODEL_MANAGER_BASE, modelManagerUrl, parseModelManagerCatalog } from './model-manager.ts'
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

/** Where the current models came from. */
export type AStudioCatalogSource = 'live' | 'saved' | 'empty'

/**
 * Why the last refresh left the catalog without a live roster.
 *
 * Machine-readable so the settings card can localize it; `empty-roster` is an
 * answer from upstream (it listed nothing), the others are failures to ask.
 */
export type AStudioCatalogFailure =
  /** No model-manager credential: AStudio is signed out, or never signed in. */
  | 'no-model-token'
  /** The endpoint answered a non-2xx status. */
  | 'http-error'
  /** The endpoint answered, but not with a model-manager document. */
  | 'invalid-payload'
  /** The request never completed. */
  | 'network-error'
  /** Upstream answered successfully and listed no models. */
  | 'empty-roster'

/** The catalog interface. */
export interface AStudioCatalog {
  /** Get the current model list. Empty means "no usable model", never a placeholder. */
  current(): readonly AStudioModelInfo[]
  /** Force a refresh from the upstream. */
  refresh(): Promise<void>
  /** Where the current models came from; `empty` carries no models at all. */
  source(): AStudioCatalogSource
  /** When the current models were fetched, for live and saved sources. */
  fetchedAtMs(): number | undefined
  /** Model ids hidden by the current identity. */
  hiddenModelIds(): readonly string[]
  /** Why there is no live roster, when that is the case. */
  failure(): AStudioCatalogFailure | undefined
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

/** One refresh's outcome: the roster, or the reason there is none. */
type FetchOutcome =
  | { ok: true, models: readonly AStudioModelInfo[] }
  | { ok: false, failure: Exclude<AStudioCatalogFailure, 'empty-roster'> }

/**
 * Create a catalog backed by the model-manager endpoint.
 *
 * Starts empty and stays empty until a refresh succeeds — there is no seed
 * list. A failed refresh keeps whatever a *previous successful* refresh left
 * on screen (a dropped poll should not blank the picker mid-session), and
 * otherwise falls back to the last saved upstream snapshot, which is also
 * upstream data rather than a substitute for it.
 */
export function createAStudioCatalog(options: AStudioCatalogOptions): AStudioCatalog {
  let cached: readonly AStudioModelInfo[] = []
  let source: AStudioCatalogSource = 'empty'
  let fetchedAtMs: number | undefined
  let failure: AStudioCatalogFailure | undefined
  const modelManagerBase = options.modelManagerBaseUrl ?? DEFAULT_MODEL_MANAGER_BASE
  const identity = options.identity ?? ASTRO_LOCAL_IDENTITY
  const catalogPath = options.catalogPath ?? astudioCatalogPath()
  const visibility = options.visibility

  /**
   * Fetch the roster from AStudio's model-manager API.
   *
   * That document is what the AStudio UI itself renders, and it carries the
   * real per-model context and output budgets. The OpenAI-compatible
   * `/v1/models` endpoint is deliberately not used: it answers with a smaller,
   * stale subset, which would drop models that are in fact callable.
   */
  async function fetchLive(): Promise<FetchOutcome> {
    const modelToken = options.modelBearerToken?.()
    if (modelToken === undefined || modelToken === '') return { ok: false, failure: 'no-model-token' }
    let res: Response
    try {
      res = await fetch(modelManagerUrl(modelManagerBase), {
        headers: { Authorization: `Bearer ${modelToken}`, Accept: 'application/json' },
      })
    } catch {
      return { ok: false, failure: 'network-error' }
    }
    if (!res.ok) return { ok: false, failure: 'http-error' }
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      return { ok: false, failure: 'invalid-payload' }
    }
    try {
      return { ok: true, models: parseModelManagerCatalog(payload) }
    } catch {
      return { ok: false, failure: 'invalid-payload' }
    }
  }

  /**
   * Apply a saved snapshot, if one exists.
   *
   * A snapshot recording zero models is accepted as-is: it is the honest
   * record of an upstream answer that listed none, and reviving models from
   * before it would contradict the live roster.
   */
  async function loadSaved(): Promise<boolean> {
    const snapshot = await readCatalogSnapshot(catalogPath, identity)
    if (snapshot === undefined) return false
    cached = snapshot.models
    source = snapshot.models.length === 0 ? 'empty' : 'saved'
    fetchedAtMs = snapshot.fetchedAtMs
    return true
  }

  async function refresh(): Promise<void> {
    const fetched = await fetchLive()

    if (fetched.ok) {
      const at = Date.now()
      // Persist even an empty roster: the snapshot is "what upstream last
      // said", and saying nothing is an answer. Skipping the write would let
      // a later failed refresh resurrect models upstream has withdrawn.
      await writeCatalogSnapshot(catalogPath, identity, fetched.models, at)
      cached = fetched.models
      source = fetched.models.length === 0 ? 'empty' : 'live'
      fetchedAtMs = at
      failure = fetched.models.length === 0 ? 'empty-roster' : undefined
      return
    }

    failure = fetched.failure

    // A dropped poll must not blank a roster that is already on screen: keep
    // the last live answer and retry on the next refresh.
    if (source === 'live' && cached.length > 0) return

    if (await loadSaved()) return

    cached = []
    source = 'empty'
    fetchedAtMs = undefined
  }

  return {
    current: () => cached,
    refresh,
    source: () => source,
    fetchedAtMs: () => fetchedAtMs,
    hiddenModelIds: () => visibility === undefined ? [] : [...(visibility.hidden(identity) ?? [])],
    failure: () => failure,
  }
}
