/**
 * AStudio account points balance.
 *
 * AStudio's own settings surface reads the account's two credit pools from its
 * loopback server (`/api/astron-auth/points-balance`), which forwards to
 * `{studioApiBaseUrl}points/balance` with the desktop session cookie. This
 * module reaches that upstream directly, using the `ssoSessionId` the desktop
 * app already writes into `astron-session.json` — the same file this plugin
 * already reads for `modelBearerToken`, so no new location discovery is needed.
 *
 * The upstream document distinguishes two pools that must never be added
 * together, because they pay for different things:
 *
 * - **general** (`totalBalance`) — every model, plus plugins and Skill calls.
 * - **spark** (`sparkTotalBalance`) — Spark-branded models only.
 *
 * Every outcome is a named state. A balance this module could not read is
 * `unavailable` or `expired`, never `0`: a confident wrong number is worse to
 * the user than an absent one.
 *
 * @module dsh-astudio-connect/points
 */

import { existsSync, readFileSync } from 'node:fs'
import type { AStudioWebPoints, AStudioWebPointsPool } from './status-paths.ts'
/** Production account API base (AStudio's baked `studioApiBaseUrl`). */
export const ASTRO_STUDIO_API_BASE = 'https://agent.xfyun.cn/xingchen-studio/'

/** The balance endpoint, resolved against the account API base. */
export const ASTRO_POINTS_BALANCE_URL = new URL('points/balance', ASTRO_STUDIO_API_BASE).toString()

/** How long a successful read is served before the upstream is asked again. */
export const ASTRO_POINTS_CACHE_MS = 30_000

/** Upstream code AStudio returns (HTTP 200) for a dead session. */
const UPSTREAM_SESSION_INVALID_CODE = 80000

/** A read the badge can present. */
export type AStudioPointsResult = AStudioWebPoints

/** Options for {@link createAStudioPointsClient}. */
export interface AStudioPointsClientOptions {
  /** The `astron-session.json` to read. */
  sessionPath: string
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  /** Injected clock, for TTL tests. */
  now?: () => number
  /** Per-read timeout. */
  timeoutMs?: number
}

/** What the plugin and route consume. */
export interface AStudioPointsClient {
  /**
   * Read the balance.
   *
   * `fresh` bypasses the TTL cache — the badge's ↻ uses it so a manual click
   * always reaches upstream.
   */
  read(options?: { fresh?: boolean }): Promise<AStudioPointsResult>
}

/** Default timeout for one upstream read. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Read the `ssoSessionId` from an AStudio session file.
 *
 * Returns undefined for a missing file, malformed JSON, an absent field, or a
 * blank value — all of which mean "not signed in", a normal state the badge
 * hides rather than an error it reports.
 */
export function readSsoSessionId(sessionPath: string): string | undefined {
  if (!existsSync(sessionPath)) return undefined
  let content: string
  try {
    content = readFileSync(sessionPath, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>)['ssoSessionId']
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

/** A finite, non-negative number, or undefined. */
function credit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Parse the account service's balance envelope.
 *
 * The envelope is the legacy Astron shape — `{ flag, code, desc, data }` — and a
 * dead session is answered with HTTP 200 plus `code: 80000`, which is why the
 * status has to be read from the body as well as the HTTP status.
 */
export function parseAStudioPointsBalance(payload: unknown): AStudioPointsResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 'unavailable' }
  }
  const envelope = payload as Record<string, unknown>

  const code = envelope['code']
  if (code === UPSTREAM_SESSION_INVALID_CODE || code === String(UPSTREAM_SESSION_INVALID_CODE)) {
    return { status: 'expired' }
  }
  if (envelope['flag'] !== true || (code !== 0 && code !== '0')) {
    return { status: 'unavailable' }
  }

  const data = envelope['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'unavailable' }
  }
  const record = data as Record<string, unknown>

  const remaining = credit(record['totalBalance'])
  if (remaining === undefined) return { status: 'unavailable' }
  const generalTotal = credit(record['totalAmount'])
  const general: AStudioWebPointsPool = generalTotal === undefined
    ? { remaining }
    : { remaining, total: generalTotal }

  const sparkRemaining = credit(record['sparkTotalBalance'])
  // The Spark pool is optional upstream: an account without one must not render
  // a zero it never had.
  if (sparkRemaining === undefined) return { status: 'ok', general }
  const sparkTotal = credit(record['sparkTotalAmount'])
  const spark: AStudioWebPointsPool = sparkTotal === undefined
    ? { remaining: sparkRemaining }
    : { remaining: sparkRemaining, total: sparkTotal }

  return { status: 'ok', general, spark }
}

/** Read one JSON answer, mapping transport failures to a named state. */
async function requestBalance(
  sessionId: string,
  options: { fetchImpl: typeof fetch, timeoutMs: number },
): Promise<AStudioPointsResult> {
  let response: Response
  try {
    response = await options.fetchImpl(ASTRO_POINTS_BALANCE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Only the session cookie travels: the chat and model-manager tokens in
        // the same file never leave the process.
        Cookie: `ssoSessionId=${sessionId}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch {
    return { status: 'unavailable' }
  }

  if (response.status === 401 || response.status === 403) return { status: 'expired' }
  if (!response.ok) return { status: 'unavailable' }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { status: 'unavailable' }
  }
  return parseAStudioPointsBalance(payload)
}

/**
 * Create the balance client.
 *
 * The session file is re-read on every upstream call rather than cached: when
 * AStudio is signed in again it rewrites that file with a new `ssoSessionId`, and
 * a cached credential would keep the badge pinned to an expired session.
 */
export function createAStudioPointsClient(options: AStudioPointsClientOptions): AStudioPointsClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let cached: AStudioPointsResult | undefined
  let cachedAtMs = 0

  return {
    async read(readOptions: { fresh?: boolean } = {}): Promise<AStudioPointsResult> {
      const fresh = readOptions.fresh === true
      if (!fresh && cached !== undefined && now() - cachedAtMs < ASTRO_POINTS_CACHE_MS) {
        return cached
      }

      const sessionId = readSsoSessionId(options.sessionPath)
      if (sessionId === undefined) return { status: 'signed-out' }

      const result = await requestBalance(sessionId, { fetchImpl, timeoutMs })
      // Only a readable answer is worth serving from cache. A failure must not
      // sticky-fail the badge: the next read asks again.
      if (result.status === 'ok') {
        cached = result
        cachedAtMs = now()
      } else {
        cached = undefined
      }
      return result
    },
  }
}
