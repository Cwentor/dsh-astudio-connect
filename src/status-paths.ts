/**
 * Shared constants and web-facing types for AStudio Connect's local HTTP
 * surfaces. Node-free: imported by both the host bundle and the browser
 * client, so it must stay dependency-free.
 *
 * @module dsh-astudio-connect/status-paths
 */

/** Status endpoint consumed by the browser half. */
export const ASTRO_STATUS_PATH = '/astudio/status'

/**
 * Probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const ASTRO_PROBE_PATH = '/astudio/probe'

/**
 * Same-origin route backing the browser's update reminder.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies; it answers public npm/GitHub metadata only and never token
 * material.
 */
export const ASTRO_UPDATE_PATH = '/astudio/update'

/**
 * Same-origin route backing the composer's points badge.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies. It answers the two credit pools the AStudio account holds and a
 * named failure state — never the session credential it reads them with.
 */
export const ASTRO_POINTS_PATH = '/astudio/points'

/** Sign-in section of the status document. */
export interface AStudioWebAuth {
  state: 'signed-in' | 'signed-out'
  tokenLength?: number
}

/** Catalog provenance section of the status document. */
export interface AStudioWebCatalog {
  source: 'live' | 'saved' | 'fallback'
  modelCount: number
  models: Array<{ id: string; name: string }>
}

/** Visibility section of the status document. */
export interface AStudioWebVisibility {
  hidden: string[]
}

/** Probe summary section of the status document. */
export interface AStudioWebProbe {
  account: string
  results: Array<{
    modelId: string
    validation: 'validating' | 'non-validating'
    efforts: string[]
    expiresAtMs: number
  }>
}

/** What the status route serves. */
export interface AStudioWebStatus {
  auth: AStudioWebAuth
  catalog: AStudioWebCatalog
  visibility: AStudioWebVisibility
  probe: AStudioWebProbe
  /**
   * In-process key authorizing probe control writes. Handed to the browser half
   * with the status document (the card is same-origin and already had to pass
   * the loopback guard); it is never persisted and rotates per process.
   */
  probeKey?: string
}

/**
 * One credit pool, as the badge renders it.
 *
 * Kept here rather than in `points.ts` because that module reads the session
 * file and therefore imports `node:fs`; the browser half may only import this
 * Node-free module.
 */
export interface AStudioWebPointsPool {
  /** Credit still available. */
  remaining: number
  /** Credit the pool started this cycle with. */
  total?: number
}

/** What the points route serves: two pools, or one named failure state. */
export type AStudioWebPoints =
  | { status: 'ok', general: AStudioWebPointsPool, spark?: AStudioWebPointsPool }
  /** No `ssoSessionId` in the session file: AStudio was never signed in here. */
  | { status: 'signed-out' }
  /** The session exists but the account service rejected it. */
  | { status: 'expired' }
  /** The service could not be read, or answered something unrecognised. */
  | { status: 'unavailable' }
