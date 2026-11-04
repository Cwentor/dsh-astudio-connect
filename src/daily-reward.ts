/**
 * AStudio's daily login reward, booked from DSH.
 *
 * The reward is delivered as a popup, not as a calendar: `client-popups/pending`
 * answers a `DAILY_REWARD_DIALOG` carrying the popup id, the instance key and
 * the credit amount, and `client-popups/complete` books it. The desktop client
 * fires that completion itself the moment it receives the dialog — the button
 * in its UI is decoration — which is why this module's "claim" means "tell the
 * account service today's dialog reached a client", not a pledge of anything.
 * The reward is therefore already booked on any day AStudio was opened; this
 * exists so it can also be booked on the days it was not.
 *
 * Two headers are mandatory (the gateway answers `11001001` without them):
 * `clientType` (`21` on Windows, `22` on macOS) and `studioVersion`. The version
 * is only shape-checked upstream, so it is a constant here rather than a value
 * read from the installed app — which is also why this needs no AStudio
 * installation, only the `ssoSessionId` the app already wrote to
 * `astron-session.json`.
 *
 * Every outcome is a named state from {@link AStudioWebClaim}. A booking that
 * could not be made is `unavailable`, never a silent success: the section tells
 * the user what happened, and only `claimed` adds credit to the display.
 *
 * `none` and `already` are kept apart on purpose. `already` is upstream saying
 * `11003002` — proof that this popup was booked before the press. `none` only
 * says the service is holding no reward right now, which is also what an
 * identified-account problem or a not-yet-issued reward looks like; calling
 * that "already claimed" is how the section once told users they had collected
 * a reward they had not.
 *
 * @module dsh-astudio-connect/daily-reward
 */

import type { AStudioPointsClient } from './points.ts'
import { ASTRO_STUDIO_API_BASE } from './points.ts'
import type { AStudioWebClaim } from './status-paths.ts'

/** Popup list endpoint, resolved against the account API base. */
export const ASTRO_DAILY_REWARD_PENDING_PATH = 'client-popups/pending'

/** Popup completion endpoint. */
export const ASTRO_DAILY_REWARD_COMPLETE_PATH = 'client-popups/complete'

/** The popup code whose payload is the daily login reward. */
export const ASTRO_DAILY_REWARD_COMPONENT = 'DAILY_REWARD_DIALOG'

/**
 * Build label sent as `studioVersion` and `clientVersion`.
 *
 * The desktop app derives both from `electron.app.getVersion()` (`3.6.0` for
 * the installed build) and injects `clientVersion` on every request to an
 * xfyun domain through `fetchWithClientVersion`. Upstream only checks the
 * shape of `studioVersion`, but we send both anyway: a request from this
 * plugin should be indistinguishable from one made by the app, and we cannot
 * rule out that the gateway uses the extra header when deciding which popups
 * to hand out.
 *
 * Hard-coded rather than read from the installed app, because claiming has to
 * work with AStudio uninstalled. Bump when a new client line ships.
 */
export const ASTRO_STUDIO_VERSION = '3.6.0'
export const ASTRO_CLIENT_VERSION = '3.6.0'

/** Account-gateway codes this module distinguishes. */
const CODE_SESSION_INVALID = 80000
const CODE_POPUP_ALREADY_COMPLETED = 11003002

/** Default timeout for one gateway call. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The `clientType` the gateway expects for this platform.
 *
 * `undefined` for a platform AStudio does not ship on: the gateway would answer
 * `11001001`, so the caller reports `unavailable` instead of sending a guess.
 */
export function astudioClientType(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return '21'
  if (platform === 'darwin') return '22'
  return undefined
}

/** Options for {@link createAStudioDailyRewardClient}. */
export interface AStudioDailyRewardClientOptions {
  /**
   * The account this claim is made against, or undefined when nobody is signed in.
   *
   * A provider, so the credential can come from the AStudio app's session file
   * or from a sign-in this plugin made itself — and so a re-login between two
   * presses is picked up instead of pinning the first session.
   */
  credentials: () => AStudioDailyRewardCredentials | undefined
  /** Balance client used to report the post-claim balance. */
  points: AStudioPointsClient
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  /** Overrides {@link astudioClientType}; `undefined` means "this platform has none". */
  clientType?: string | undefined
  /** Overrides {@link ASTRO_STUDIO_VERSION}. */
  studioVersion?: string
  /** Overrides {@link ASTRO_CLIENT_VERSION}. */
  clientVersion?: string
  /** Per-call timeout. */
  timeoutMs?: number
}

/**
 * The cookie parts the account APIs authenticate with.
 *
 * Mirrors what the desktop client sends: `ssoSessionId` and `sso_sessionid`
 * are the same value under both names, and `account_id`/`token` are what make
 * the request *account-scoped* rather than merely session-scoped. `token` is
 * absent for a QR sign-in this plugin made itself — that exchange returns a
 * model key, not an account token — and is then left out rather than guessed.
 */
export interface AStudioDailyRewardCredentials {
  ssoSessionId: string
  accountId?: string
  token?: string
}

/** What the plugin and the claim route consume. */
export interface AStudioDailyRewardClient {
  /** Book today's reward, if the account service is holding one. */
  claim(): Promise<AStudioWebClaim>
}

/** One answer from the account gateway, reduced to what this module acts on. */
type GatewayAnswer =
  | { kind: 'ok', data: unknown }
  /** The session is dead (`code: 80000`, or 401/403 on the HTTP layer). */
  | { kind: 'expired' }
  /** This popup was already completed — by AStudio, or by an earlier press. */
  | { kind: 'already' }
  /** Transport failure, non-2xx, or an unreadable body. */
  | { kind: 'failed' }

/** One claimable daily reward, as the pending list describes it. */
interface PendingReward {
  /** A positive integer, not a string — the completion endpoint takes a number. */
  popupId: number
  instanceKey: string
  /** Announced amount; `undefined` when the payload carries none this module can read. */
  points: number | undefined
}

/**
 * Read a popup id the way the desktop client does.
 *
 * The id is a positive integer on the wire, and `client-popups/complete` is
 * parsed with `Number.isSafeInteger` upstream. Accepting only strings here is
 * what once made every real reward look like "nothing pending": the popup was
 * delivered, failed this test, and the section announced a reward that had
 * never been booked.
 */
function popupIdOf(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * Reduce the gateway's `{ flag, code, desc, data }` envelope.
 *
 * A dead session is answered with HTTP 200 plus `code: 80000`, so the status has
 * to be read from the body as well as from the HTTP status — the same rule the
 * balance reader follows.
 */
function readEnvelope(payload: unknown): GatewayAnswer {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { kind: 'failed' }
  const envelope = payload as Record<string, unknown>
  const raw = envelope['code']
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (code === CODE_SESSION_INVALID) return { kind: 'expired' }
  if (code === CODE_POPUP_ALREADY_COMPLETED) return { kind: 'already' }
  if (envelope['flag'] !== true || code !== 0) return { kind: 'failed' }
  return { kind: 'ok', data: envelope['data'] }
}

/** The announced amount, or `undefined` when it is absent or unreadable. */
function announcedPoints(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = (payload as Record<string, unknown>)['points']
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Pick the daily rewards out of a pending list.
 *
 * Anything else the account service is holding — announcements, feature tours,
 * download prompts — is left alone: completing a popup this module did not
 * understand would be acting on the user's behalf without knowing what for.
 */
function pendingRewards(data: unknown): PendingReward[] {
  if (!Array.isArray(data)) return []
  const rewards: PendingReward[] = []
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    if (item['componentType'] !== ASTRO_DAILY_REWARD_COMPONENT) continue
    const popupId = popupIdOf(item['popupId'])
    const instanceKey = item['instanceKey']
    if (popupId === undefined) continue
    if (typeof instanceKey !== 'string' || instanceKey === '') continue
    rewards.push({ popupId, instanceKey, points: announcedPoints(item['payload']) })
  }
  return rewards
}

/**
 * Build the cookie header the account APIs expect.
 *
 * Same four pairs the desktop client sends, in the same order. The claim is not
 * an anonymous "is there a reward?" question — the popup service answers an
 * unidentified caller with an empty list, which is indistinguishable from "no
 * reward today" unless the account travels with the request.
 */
function claimCookie(credentials: AStudioDailyRewardCredentials): string {
  const parts = [
    `ssoSessionId=${credentials.ssoSessionId}`,
    `sso_sessionid=${credentials.ssoSessionId}`,
  ]
  if (credentials.accountId !== undefined) parts.push(`account_id=${credentials.accountId}`)
  if (credentials.token !== undefined) parts.push(`token=${credentials.token}`)
  return parts.join('; ')
}

/**
 * Create the claim client.
 *
 * The session file is re-read on every call for the same reason the balance
 * reader does: AStudio rewrites it on re-login, and a cached credential would
 * pin this to an expired session.
 */
export function createAStudioDailyRewardClient(options: AStudioDailyRewardClientOptions): AStudioDailyRewardClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const clientType = 'clientType' in options ? options.clientType : astudioClientType()
  const studioVersion = options.studioVersion ?? ASTRO_STUDIO_VERSION
  const clientVersion = options.clientVersion ?? ASTRO_CLIENT_VERSION
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const call = async (credentials: AStudioDailyRewardCredentials, path: string, init: RequestInit = {}): Promise<GatewayAnswer> => {
    let response: Response
    try {
      response = await fetchImpl(new URL(path, ASTRO_STUDIO_API_BASE), {
        ...init,
        headers: {
          Accept: 'application/json',
          // Only the account cookies travel; the chat and model-manager tokens
          // in the same file never leave the process.
          Cookie: claimCookie(credentials),
          ...(clientType === undefined ? {} : { clientType }),
          studioVersion,
          clientVersion,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { kind: 'failed' }
    }
    if (response.status === 401 || response.status === 403) return { kind: 'expired' }
    if (!response.ok) return { kind: 'failed' }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { kind: 'failed' }
    }
    return readEnvelope(payload)
  }

  return {
    async claim(): Promise<AStudioWebClaim> {
      const credentials = options.credentials()
      if (credentials === undefined) return { status: 'signed-out' }
      // A platform AStudio does not ship on cannot pass the gateway's identity
      // check, so there is nothing to send.
      if (clientType === undefined) return { status: 'unavailable' }

      const pending = await call(credentials, ASTRO_DAILY_REWARD_PENDING_PATH)
      if (pending.kind === 'expired') return { status: 'expired' }
      if (pending.kind !== 'ok') return { status: 'unavailable' }
      const rewards = pendingRewards(pending.data)
      if (rewards.length === 0) return { status: 'none' }

      let booked = 0
      let alreadyBooked = 0
      let bookedAmount: number | undefined
      for (const reward of rewards) {
        const answer = await call(credentials, ASTRO_DAILY_REWARD_COMPLETE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ popupId: reward.popupId, instanceKey: reward.instanceKey }),
        })
        if (answer.kind === 'expired') return { status: 'expired' }
        // `already` means this popup was booked before this press — by AStudio,
        // or by an earlier press. It is not a second reward, so it does not get
        // counted as one: reporting `+100` for a booking we did not make is
        // exactly the claim the section must not fabricate.
        if (answer.kind === 'already') {
          alreadyBooked += 1
          continue
        }
        if (answer.kind === 'ok') {
          booked += 1
          if (reward.points !== undefined) bookedAmount = (bookedAmount ?? 0) + reward.points
          continue
        }
        // Nothing booked at all: report the failure instead of a half-claim.
        if (booked === 0) return { status: 'unavailable' }
        break
      }

      // Every popup was refused as already completed: the reward is real and it
      // is not ours to book again.
      if (booked === 0) return { status: alreadyBooked > 0 ? 'already' : 'none' }

      // The balance is read fresh through the section's own client, so the number
      // on screen is in the same vocabulary as every other read. A failed read
      // does not undo the claim — the document carries its own status.
      const balance = await options.points.read({ fresh: true })
      return bookedAmount === undefined
        ? { status: 'claimed', balance }
        : { status: 'claimed', points: bookedAmount, balance }
    },
  }
}
