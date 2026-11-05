/**
 * AStudio's daily login reward, booked from DSH.
 *
 * The reward is credited during the tenant-app initialisation the desktop app
 * performs at launch (`tenant-app/v2/init-app`), and announced afterwards as a
 * `DAILY_REWARD_DIALOG` popup on `client-popups/pending`. `client-popups/complete`
 * only closes that dialog — measured on 2026-11-05, the balance had already
 * risen by 100 before any completion was sent, and stayed put when one was.
 *
 * That ordering is the whole reason this module exists in its current shape.
 * An earlier version read `pending` and nothing else, which answers an empty
 * list on every day the desktop app was never opened: nothing had asked the
 * account service to settle the day. Claiming now reproduces the app's launch —
 * initialise, read the popups, close them — so the reward can be booked with
 * AStudio uninstalled, from a DSH profile, on a machine the app never launched
 * on that day.
 *
 * Two headers are mandatory (the gateway answers `11001001` without them):
 * `clientType` (`21` on Windows, `22` on macOS) and `studioVersion`. The version
 * is only shape-checked upstream, so it is a constant here rather than a value
 * read from the installed app — which is also why this needs no AStudio
 * installation, only the `ssoSessionId` the app already wrote to
 * `astron-session.json`.
 *
 * The amount is read from the balance before and after the initialisation, not
 * from the popup: current clients send `{ title, content, confirmText }` as the
 * payload and no figure at all. A payload that does carry `points` is still
 * understood, for builds that send it.
 *
 * Every outcome is a named state from {@link AStudioWebClaim}. A booking that
 * could not be made is `unavailable`, never a silent success: the section tells
 * the user what happened, and only `claimed` adds credit to the display.
 *
 * `none` and `already` are kept apart on purpose. `already` means a dialog was
 * closed while the balance did not move — the credit was on the account before
 * the press. `none` means the account service settled the day without handing
 * out anything, which is what an expired plan looks like; calling that
 * "already claimed" is how the section once told users they had collected a
 * reward they had not.
 *
 * @module dsh-astudio-connect/daily-reward
 */

import type { AStudioPointsClient } from './points.ts'
import { ASTRO_STUDIO_API_BASE } from './points.ts'
import type { AStudioWebClaim } from './status-paths.ts'

/**
 * Tenant-app initialisation endpoint, resolved against the account API base.
 *
 * The desktop app calls this once per launch and the account service credits
 * the day's login reward while answering it. It is not a claim endpoint and
 * announces nothing; without it `pending` stays empty all day, which is the bug
 * that made this module report "nothing to claim" on days AStudio was closed.
 */
export const ASTRO_TENANT_INIT_PATH = 'tenant-app/v2/init-app'

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

/**
 * One claimable daily reward, as the pending list describes it.
 *
 * The payload is deliberately not carried: current clients send no amount in
 * it, so the only figure this module trusts is the balance difference across
 * the initialisation.
 */
interface PendingReward {
  /** A positive integer, not a string — the completion endpoint takes a number. */
  popupId: number
  instanceKey: string
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
    rewards.push({ popupId, instanceKey })
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

      // The balance before the trigger. Read first because the credit lands
      // during initialisation: a read taken afterwards alone could not tell
      // "this press earned 100" from "100 was already there".
      const before = await options.points.read({ fresh: true })
      if (before.status === 'expired') return { status: 'expired' }
      const beforeCredit = before.status === 'ok' ? before.general.remaining : undefined

      // Reproduce the desktop app's launch. This is the call that asks the
      // account service to settle the day; `pending` on its own mints nothing.
      // A failure here is not fatal — a reward issued by an earlier session may
      // still have its dialog open and worth closing.
      const init = await call(credentials, ASTRO_TENANT_INIT_PATH, { method: 'POST' })
      if (init.kind === 'expired') return { status: 'expired' }

      const pending = await call(credentials, ASTRO_DAILY_REWARD_PENDING_PATH)
      if (pending.kind === 'expired') return { status: 'expired' }
      const rewards = pending.kind === 'ok' ? pendingRewards(pending.data) : []

      // Only the daily dialog is touched: any other popup in the same list is
      // somebody else's announcement, and closing it would be acting on the
      // user's behalf without knowing what for.
      let closed = 0
      for (const reward of rewards) {
        const answer = await call(credentials, ASTRO_DAILY_REWARD_COMPLETE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ popupId: reward.popupId, instanceKey: reward.instanceKey }),
        })
        if (answer.kind === 'expired') return { status: 'expired' }
        // `already` is harmless here: the dialog is gone either way, which is
        // all this call was for.
        if (answer.kind === 'ok' || answer.kind === 'already') closed += 1
      }

      // The balance is read fresh through the section's own client, so the
      // number on screen is in the same vocabulary as every other read.
      const balance = await options.points.read({ fresh: true })
      const afterCredit = balance.status === 'ok' ? balance.general.remaining : undefined
      const added = beforeCredit !== undefined && afterCredit !== undefined
        ? afterCredit - beforeCredit
        : undefined

      // Credit moved: this press is the reason, whatever the dialogs did.
      if (added !== undefined && added > 0) return { status: 'claimed', points: added, balance }

      // The dialog list could not be read, so "nothing pending" is not
      // established — report the failure rather than invent an outcome.
      if (pending.kind !== 'ok') return { status: 'unavailable' }

      // Settled, nothing issued: no dialog to close and no credit added.
      if (rewards.length === 0) return { status: 'none' }

      if (added === 0) {
        // A dialog was closed and the balance did not move, which means the
        // credit was already on the account. Only an initialisation the service
        // accepted can support that reading: a failed one leaves the day
        // unsettled, and "already claimed" would then be a guess.
        return init.kind === 'ok' ? { status: 'already' } : { status: 'unavailable' }
      }

      // Balance unreadable on both ends: a closed dialog after a successful
      // initialisation is the client's own success path, so report the claim
      // without an amount instead of a failure that did not happen.
      if (closed > 0) return { status: 'claimed', balance }

      // Payment unconfirmed and the dialog would not close.
      return { status: 'unavailable' }
    },
  }
}
