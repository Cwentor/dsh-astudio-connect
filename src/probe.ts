/**
 * AStudio reasoning-effort probe primitives. A probe sends a deliberately tiny
 * chat request carrying a sentinel string, so it can establish whether the
 * upstream actually validates the reasoning-effort parameter.
 *
 * @module dsh-astudio-connect/probe
 */

import type { AStudioUpstreamClient } from './upstream.ts'

/** Outcome of one probe attempt. */
export interface ProbeOutcome {
  state: 'ok' | 'rejected' | 'failed' | 'unauthorized'
  validation?: 'validating' | 'non-validating'
  efforts: string[]
  reason?: string
}

/** Generate a random sentinel string for the probe prompt. */
export function randomSentinel(): string {
  return `probe-${Math.random().toString(36).slice(2, 10)}`
}

/** Build a minimal chat completions body for a probe. */
export function probeBody(modelId: string, effort: string, sentinel: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: 'user', content: sentinel }],
    max_tokens: 1,
    reasoning_effort: effort,
  }
}

/** Per-request ceiling so one hung probe cannot stall the queue. */
export const PROBE_REQUEST_TIMEOUT_MS = 30_000

/** Classify an upstream failure text into a probe state. */
export function classifyProbeFailure(message: string): { state: 'rejected' | 'failed'; validation?: 'non-validating'; reason: string } {
  const normalized = message.toLowerCase()
  if (normalized.includes('invalid_parameter_value')) {
    return { state: 'rejected', validation: 'non-validating', reason: 'upstream rejected the reasoning effort' }
  }
  return { state: 'failed', reason: message.slice(0, 400) }
}

/** Send one probe request through the upstream client. */
export async function probeModel(options: {
  upstream: AStudioUpstreamClient
  token: string
  modelId: string
  effort: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const sentinel = randomSentinel()
  const body = probeBody(options.modelId, options.effort, sentinel)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await options.upstream.chat(
      options.token,
      body,
      options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
    )

    if (!result.ok) {
      const classified = classifyProbeFailure(result.message)
      return { ...classified, efforts: [] }
    }

    return {
      state: 'ok',
      validation: 'validating',
      efforts: [options.effort],
    }
  } finally {
    clearTimeout(timer)
  }
}
