/**
 * Shared constants and web-facing types for AStudio Connect's local HTTP
 * surfaces. Node-free: imported by both the host bundle and the browser
 * client, so it must stay dependency-free.
 *
 * The two catalog types below are imported `type`-only from `catalog.ts`, so
 * nothing in this module gains a runtime import (and the browser half never
 * pulls in the catalog's `node:fs` dependency).
 *
 * @module dsh-astudio-connect/status-paths
 */

import type { AStudioCatalogFailure, AStudioCatalogSource } from './catalog.ts'

export type { AStudioCatalogFailure, AStudioCatalogSource }

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
 * Model-visibility control endpoint.
 *
 * `POST /astudio/visibility/{modelId}` with `{ visible: boolean }` writes one
 * model's exposure for the current identity. Same guards as the probe route
 * (loopback Host + the in-process control key): it edits persisted preferences,
 * so loopback alone is not enough.
 */
export const ASTRO_VISIBILITY_PATH = '/astudio/visibility'

/**
 * Header carrying the per-process control key on every state-changing write.
 *
 * Same key, same trust level, one name: the card receives it inside the status
 * document and echoes it back here.
 */
export const ASTRO_CONTROL_KEY_HEADER = 'x-astudio-control-key'

/**
 * Header the card sent before visibility writes existed.
 *
 * Still accepted by the host: an already-loaded browser bundle outlives a host
 * restart inside the same tab, and locking it out of its own routes would
 * break probing until the page is reloaded. Drop it when no supported DSH
 * release ships a client that predates {@link ASTRO_CONTROL_KEY_HEADER}.
 */
export const ASTRO_LEGACY_PROBE_KEY_HEADER = 'x-astudio-probe-key'

/**
 * Same-origin route backing the browser's update reminder.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies; it answers public npm/GitHub metadata only and never token
 * material.
 */
export const ASTRO_UPDATE_PATH = '/astudio/update'

/**
 * Same-origin route backing the points section in Settings.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies. It answers the two credit pools the AStudio account holds and a
 * named failure state — never the session credential it reads them with.
 */
export const ASTRO_POINTS_PATH = '/astudio/points'

/**
 * Same-origin route backing the points section's claim button.
 *
 * Unlike the two routes above this one **writes**: it books the account
 * service's daily login reward. It therefore carries the same three guards as
 * the other write routes — loopback Host, loopback Origin, and the in-process
 * control key — and answers a named state rather than an error body.
 */
export const ASTRO_CLAIM_PATH = '/astudio/claim'

/**
 * Same-origin route that starts a WeChat QR sign-in.
 *
 * A write like the claim route, and guarded the same way: this one asks the
 * account service to mint a login ticket, which is not something any page that
 * reaches `127.0.0.1` should be able to do. The answer carries the QR image as
 * a data URL, so the browser loads nothing from a third-party host.
 */
export const ASTRO_LOGIN_QR_PATH = '/astudio/login/qr'

/**
 * Same-origin route that polls a started QR sign-in.
 *
 * Separate from {@link ASTRO_LOGIN_QR_PATH} because it is what actually writes a
 * credential — the poll that sees a scan exchanges the ticket for a model key
 * and persists it. Same three guards.
 */
export const ASTRO_LOGIN_QR_POLL_PATH = '/astudio/login/qr/poll'

/** Same-origin route that forgets the plugin's own sign-in. */
export const ASTRO_LOGOUT_PATH = '/astudio/login/logout'

/** Sign-in section of the status document. */
export interface AStudioWebAuth {
  state: 'signed-in' | 'signed-out'
  tokenLength?: number
}

/**
 * Where the credential in use came from.
 *
 * `dsh` is a sign-in performed here (the QR flow) and stored by the plugin;
 * `client` is one read out of the AStudio app's own files. The distinction is
 * the whole point of the QR flow — it is what lets the plugin work with AStudio
 * uninstalled — so the UI names it rather than hiding it behind "signed in".
 */
export interface AStudioWebLogin {
  source: 'dsh' | 'client' | 'none'
  /** Account id, present when the source names one. */
  accountId?: string
  nickname?: string
  avatar?: string
  /** ISO timestamp of the sign-in that produced this credential. */
  loggedInAt?: string
}

/** What a started QR sign-in answers. */
export type AStudioWebQrStart =
  | {
    status: 'ok'
    /** Ticket handle the poll route takes back. */
    fd: string
    /** `data:image/...` QR code, safe to put straight in an `img src`. */
    image: string
    /** Epoch milliseconds after which the ticket is worthless. */
    expiresAtMs: number
  }
  | { status: 'unavailable' }

/**
 * What one poll answers.
 *
 * `unbound` is not an error: the scan worked, that WeChat account simply has no
 * AStudio account attached to it. `select-account` appears when it has several,
 * and the press that picks one polls again with its id.
 */
export type AStudioWebQrPoll =
  /** No scan yet. */
  | { status: 'pending' }
  /** The ticket aged out (or was never valid here). Start a new one. */
  | { status: 'expired' }
  | { status: 'unbound' }
  | {
    status: 'select-account'
    accounts: Array<{ accountId: string, username?: string }>
    avatar?: string
  }
  | { status: 'authenticated', login: AStudioWebLogin }
  /** Scanned and exchanged, but the account has no model credential to offer. */
  | { status: 'no-credential' }
  | { status: 'unavailable' }

/**
 * Catalog provenance section of the status document.
 *
 * `models` is empty exactly when `source` is `empty`: there is no built-in
 * roster to fall back to, so an absent upstream answer is reported as an
 * absent roster rather than filled in. `failure` says why, for the card copy.
 */
export interface AStudioWebCatalog {
  source: AStudioCatalogSource
  modelCount: number
  models: Array<{ id: string; name: string }>
  failure?: AStudioCatalogFailure
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
   * Which sign-in the credential came from.
   *
   * Optional so an older host without the QR flow still satisfies the type —
   * the section reads it as `none` when absent and offers the QR sign-in.
   */
  login?: AStudioWebLogin
  /**
   * In-process key authorizing every control write from the card (probe and
   * model visibility). Handed to the browser half with the status document
   * (the card is same-origin and already had to pass the loopback guard); it is
   * never persisted and rotates per process.
   */
  controlKey?: string
}

/**
 * One credit pool, as the section renders it.
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

/**
 * What the claim route serves.
 *
 * `claimed` carries the balance read immediately after the reward landed, so
 * the section can show the new number without a second round trip. That balance
 * is a full {@link AStudioWebPoints} document: the claim succeeded even if the
 * follow-up read did not, and a failed read must not turn a booked reward into
 * an error.
 *
 * `points` is what the popup announced. Deliberately optional: the amount is a
 * string in the popup payload, and an unparsable one is reported as "claimed,
 * amount unknown" rather than as `+0`.
 */
export type AStudioWebClaim =
  | { status: 'claimed', points?: number, balance: AStudioWebPoints }
  /**
   * A daily dialog was closed while the balance did not move: today's credit
   * was already on the account before this press.
   *
   * Measured on 2026-11-05: the desktop client credits the reward as it
   * initialises the tenant app and only then shows the dialog, so an unclosed
   * dialog on an already-credited account is a normal state — usually a client
   * that was closed before it could dismiss the banner.
   */
  | { status: 'already' }
  /** The account service settled the day without issuing a reward. */
  | { status: 'none' }
  | { status: 'signed-out' }
  | { status: 'expired' }
  | { status: 'unavailable' }
