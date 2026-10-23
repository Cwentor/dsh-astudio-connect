/**
 * The per-process control key that authorizes the settings card's
 * state-changing writes — reasoning-effort probes and model-visibility toggles.
 *
 * Loopback Host is not authentication: any local process can send
 * `Host: 127.0.0.1`. A route that spends an upstream request, or edits
 * persisted preferences, therefore has to prove the caller was handed this key.
 * It is minted once per process, delivered only inside the same-origin status
 * document, never written to disk, and rotates when the host restarts.
 *
 * @module dsh-astudio-connect/control-key
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { ASTRO_CONTROL_KEY_HEADER, ASTRO_LEGACY_PROBE_KEY_HEADER } from './status-paths.ts'

/** Mint a fresh control key. 24 bytes of hex: enough that guessing is not a path. */
export function createControlKey(): string {
  return randomBytes(24).toString('hex')
}

/** Collapse a header value that node may deliver as an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Read the presented key, preferring the current header name over the legacy
 * one. See {@link ASTRO_LEGACY_PROBE_KEY_HEADER} for why the legacy name is
 * still honoured.
 */
export function readControlKey(headers: IncomingHttpHeaders): string | undefined {
  return one(headers[ASTRO_CONTROL_KEY_HEADER]) ?? one(headers[ASTRO_LEGACY_PROBE_KEY_HEADER])
}

/**
 * Constant-time key comparison; a length mismatch is a failure, not a crash.
 *
 * `timingSafeEqual` throws on unequal lengths, so the length check has to come
 * first — and it must not itself leak more than the length, which is fixed for
 * any real key.
 */
export function controlKeyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}
