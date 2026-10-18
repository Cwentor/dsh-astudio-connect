/**
 * AStudio reasoning-probe service. It gates probe requests on explicit user
 * consent, delegates the wire attempt to {@link probeModel}, and persists only
 * validating observations.
 *
 * @module dsh-astudio-connect/probe-service
 */

import { localIdentity } from './identity.ts'
import type { AStudioUpstreamClient } from './upstream.ts'
import type { AStudioProbeStore } from './probe-store.ts'
import { probeModel, type ProbeOutcome } from './probe.ts'

/** Probe retention window. */
const PROBE_RETENTION_MS = 24 * 60 * 60 * 1000

/** Options for creating a probe service. */
export interface AStudioProbeServiceOptions {
  upstream: AStudioUpstreamClient
  token: () => string | undefined
  store: AStudioProbeStore
  account?: string
}

/** Probe service surface. */
export interface AStudioProbeService {
  probe(modelId: string, effort: string, consent: boolean, signal?: AbortSignal): Promise<ProbeOutcome>
}

/** Create a probe service. */
export function createAStudioProbeService(options: AStudioProbeServiceOptions): AStudioProbeService {
  const account = options.account ?? localIdentity()

  async function probe(modelId: string, effort: string, consent: boolean, signal?: AbortSignal): Promise<ProbeOutcome> {
    if (!consent) {
      return { state: 'unauthorized', efforts: [], reason: 'reasoning-effort probes are disabled' }
    }
    const token = options.token()
    if (token === undefined) {
      return { state: 'unauthorized', efforts: [], reason: 'AStudio token not available' }
    }

    const result = await probeModel({
      upstream: options.upstream,
      token,
      modelId,
      effort,
      ...signal === undefined ? {} : { signal },
    })

    if (result.state === 'ok' && result.validation === 'validating') {
      await options.store.put({
        account,
        modelId,
        validation: 'validating',
        efforts: result.efforts,
        expiresAtMs: Date.now() + PROBE_RETENTION_MS,
      })
    }

    return result
  }

  return { probe }
}
