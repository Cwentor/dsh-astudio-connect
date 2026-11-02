/**
 * Browser-side calls to the two same-origin points routes.
 *
 * Kept apart from the component that renders them for one reason: every fetch
 * shape here is a contract with a host route, and a contract is easier to
 * assert — and to change — when it is not buried in JSX. Each function answers
 * a named value or `undefined`; none of them throws past its own boundary, so a
 * caller never has to wrap a read in a try/catch to stay renderable.
 *
 * @module dsh-astudio-connect/client/points-client
 */

import {
  ASTRO_CLAIM_PATH,
  ASTRO_CONTROL_KEY_HEADER,
  ASTRO_LOGIN_QR_PATH,
  ASTRO_LOGIN_QR_POLL_PATH,
  ASTRO_LOGOUT_PATH,
  ASTRO_POINTS_PATH,
  ASTRO_STATUS_PATH,
} from '../status-paths.ts'
import type {
  AStudioWebClaim,
  AStudioWebPoints,
  AStudioWebQrPoll,
  AStudioWebQrStart,
  AStudioWebStatus,
} from '../status-paths.ts'
import { isAStudioWebStatus } from './status-document.ts'

/** Narrow an unknown JSON value to the points route's document. */
export function isPointsDocument(value: unknown): value is AStudioWebPoints {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  return status === 'ok' || status === 'signed-out' || status === 'expired' || status === 'unavailable'
}

/** Narrow an unknown JSON value to the claim route's document. */
export function isClaimDocument(value: unknown): value is AStudioWebClaim {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  return status === 'claimed' || status === 'none' || status === 'signed-out' || status === 'expired' || status === 'unavailable'
}

/** Narrow an unknown JSON value to the QR start route's document. */
export function isQrStartDocument(value: unknown): value is AStudioWebQrStart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['status'] === 'unavailable') return true
  return record['status'] === 'ok'
    && typeof record['fd'] === 'string'
    && typeof record['image'] === 'string'
    && typeof record['expiresAtMs'] === 'number'
}

/** Narrow an unknown JSON value to the QR poll route's document. */
export function isQrPollDocument(value: unknown): value is AStudioWebQrPoll {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  return status === 'pending'
    || status === 'expired'
    || status === 'unbound'
    || status === 'select-account'
    || status === 'authenticated'
    || status === 'no-credential'
    || status === 'unavailable'
}

/**
 * Read the two pools, or the named reason they could not be read.
 *
 * `fresh` appends `?refresh=1`, which bypasses the host's 30-second cache. An
 * unreadable answer is reported as `unavailable` rather than thrown: the panel
 * has a state for it, and a rejected promise would only turn a readable failure
 * into a blank section.
 */
export async function readPoints(fresh: boolean): Promise<AStudioWebPoints> {
  try {
    const response = await fetch(fresh ? `${ASTRO_POINTS_PATH}?refresh=1` : ASTRO_POINTS_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !isPointsDocument(value)) return { status: 'unavailable' }
    return value
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * Read the status document.
 *
 * Two things come out of it: the control key every write needs, and which
 * sign-in the credential came from. Read per action rather than cached — the
 * key rotates when the host restarts, and a stale copy would turn every later
 * write into a 403 that looks like a broken account.
 */
export async function readStatus(): Promise<AStudioWebStatus | undefined> {
  try {
    const response = await fetch(ASTRO_STATUS_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !isAStudioWebStatus(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Read the in-process control key, or undefined when the host did not hand one out. */
export async function readControlKey(): Promise<string | undefined> {
  const status = await readStatus()
  return status?.controlKey === undefined || status.controlKey === '' ? undefined : status.controlKey
}

/**
 * POST to a login route.
 *
 * All three login calls share this shape: JSON in, a document or `undefined`
 * out, never a throw. `undefined` means the route refused or answered something
 * unrecognised, which the panel reports as "unavailable" — the same verdict a
 * failed balance read gets.
 */
async function postLogin(path: string, controlKey: string, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        [ASTRO_CONTROL_KEY_HEADER]: controlKey,
      },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return await response.json().catch(() => undefined)
  } catch {
    return undefined
  }
}

/** Mint a QR ticket. The image comes back as a data URL, so nothing loads off-origin. */
export async function startQrLogin(controlKey: string): Promise<AStudioWebQrStart | undefined> {
  const value = await postLogin(ASTRO_LOGIN_QR_PATH, controlKey)
  return isQrStartDocument(value) ? value : undefined
}

/** Read one ticket, and finish the sign-in when it has been scanned. */
export async function pollQrLogin(
  controlKey: string,
  input: { fd: string, accountId?: string },
): Promise<AStudioWebQrPoll | undefined> {
  const value = await postLogin(ASTRO_LOGIN_QR_POLL_PATH, controlKey, input)
  return isQrPollDocument(value) ? value : undefined
}

/** Forget the plugin's own sign-in, falling back to whatever AStudio has on disk. */
export async function signOut(controlKey: string): Promise<boolean> {
  const value = await postLogin(ASTRO_LOGOUT_PATH, controlKey)
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['status'] === 'ok'
}

/**
 * Book today's daily login reward.
 *
 * `undefined` means the route refused or answered something unrecognised.
 * Everything else is the route's own named state, including `claimed` with a
 * balance that itself may have failed to read — a booked reward must not be
 * reported as an error just because the follow-up read did not land.
 */
export async function claimDailyReward(controlKey: string): Promise<AStudioWebClaim | undefined> {
  try {
    const response = await fetch(ASTRO_CLAIM_PATH, {
      method: 'POST',
      headers: { accept: 'application/json', [ASTRO_CONTROL_KEY_HEADER]: controlKey },
      credentials: 'same-origin',
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !isClaimDocument(value)) return undefined
    return value
  } catch {
    return undefined
  }
}
