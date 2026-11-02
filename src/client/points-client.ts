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
  ASTRO_POINTS_PATH,
  ASTRO_STATUS_PATH,
} from '../status-paths.ts'
import type { AStudioWebClaim, AStudioWebPoints } from '../status-paths.ts'
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
 * Read the in-process control key from the status document.
 *
 * The claim is a write, so it needs the key the host hands the browser half
 * with that document. It is read per press rather than cached: the key rotates
 * when the host restarts, and a stale copy would turn every later press into a
 * 403 that looks like a broken account.
 */
export async function readControlKey(): Promise<string | undefined> {
  try {
    const response = await fetch(ASTRO_STATUS_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !isAStudioWebStatus(value)) return undefined
    return value.controlKey === undefined || value.controlKey === '' ? undefined : value.controlKey
  } catch {
    return undefined
  }
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
