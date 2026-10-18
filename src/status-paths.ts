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
}
