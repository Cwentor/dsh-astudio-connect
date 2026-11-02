/**
 * The plugin's own AStudio sign-in.
 *
 * Until this existed, the plugin was a pure reader: it took the credential
 * AStudio had already written and never put one on disk itself. A QR sign-in
 * cannot work that way — the whole point is not needing the app — so the
 * session it yields has to live somewhere. It lives here: one file under the
 * DSH home, written only when a person scans a code, readable only by them
 * (`0600`), and deleted by "sign out".
 *
 * The record keeps the two things the rest of the plugin needs and nothing
 * else: the `ssoSessionId` cookie the account API is called with, and the model
 * key (`api_key`) that authenticates inference. `api_key` is exactly what the
 * AStudio app stores as `experimental_bearer_token`, so every downstream seam
 * — shim, catalog, probe — reads the same kind of value it always did.
 *
 * Precedence: this file wins over the app's `astron-session.json` /
 * `config.toml`. That is deliberate. Someone who signs in here has said "use
 * this account"; silently preferring a stale file from an app they may have
 * uninstalled would make the QR flow look broken. Signing out falls back.
 *
 * @module dsh-astudio-connect/login-session
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AStudioWebLogin } from './status-paths.ts'

/** Basename of the login session inside the DSH home. */
export const ASTRO_LOGIN_SESSION_FILENAME = '.astudio-login.json'

/** On-disk format; readers reject anything else. */
const LOGIN_SESSION_FORMAT_VERSION = 1

/**
 * A sign-in this plugin performed and stored.
 *
 * `ssoSessionId` and `modelBearerToken` are secrets: they are never returned to
 * the browser. Callers that need to show "who is signed in" read the accessors
 * on the credential store, which report only the identity fields.
 */
export interface AStudioLoginSession {
  version: typeof LOGIN_SESSION_FORMAT_VERSION
  /** AStudio account id the session belongs to. */
  accountId: string
  /** Account cookie; the balance, popups and model-config APIs take this. */
  ssoSessionId: string
  /** Model key (`api_key`) used as the chat bearer token. */
  modelBearerToken?: string
  nickname?: string
  avatar?: string
  /** How this session was obtained. Only the QR flow writes here today. */
  loginMethod: 'wechat-qr'
  /** ISO timestamp of the sign-in. */
  loggedInAt: string
}

/** Absolute path of the login session file. */
export function astudioLoginSessionPath(): string {
  return join(resolveDshHome(), ASTRO_LOGIN_SESSION_FILENAME)
}

/** A non-blank trimmed string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse a stored login session.
 *
 * Returns undefined for anything that cannot be trusted to be one: a document
 * without an account id or cookie is not a sign-in, whatever else it holds.
 */
export function parseLoginSession(value: unknown): AStudioLoginSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['version'] !== LOGIN_SESSION_FORMAT_VERSION) return undefined
  const accountId = text(record['accountId'])
  const ssoSessionId = text(record['ssoSessionId'])
  if (accountId === undefined || ssoSessionId === undefined) return undefined
  const modelBearerToken = text(record['modelBearerToken'])
  const nickname = text(record['nickname'])
  const avatar = text(record['avatar'])
  const loggedInAt = text(record['loggedInAt'])
  return {
    version: LOGIN_SESSION_FORMAT_VERSION,
    accountId,
    ssoSessionId,
    ...(modelBearerToken === undefined ? {} : { modelBearerToken }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(avatar === undefined ? {} : { avatar }),
    // The QR flow is the only writer; a record from anywhere else is still a
    // sign-in this plugin made, so the field carries no branch of its own.
    loginMethod: 'wechat-qr',
    loggedInAt: loggedInAt ?? new Date(0).toISOString(),
  }
}

/**
 * Read the stored sign-in.
 *
 * Never throws: an unreadable or malformed file means "no session of our own",
 * which is a state the plugin already knows how to be in.
 */
export function readLoginSession(path: string = astudioLoginSessionPath()): AStudioLoginSession | undefined {
  if (!existsSync(path)) return undefined
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  return parseLoginSession(parsed)
}

/**
 * Write the sign-in, readable by this user only.
 *
 * Written to a sibling temporary file and renamed into place so a crash
 * mid-write cannot leave a half session behind — the rename is atomic within a
 * directory, and the file is created with `0600` from the start rather than
 * restricted afterwards.
 */
export function writeLoginSession(session: AStudioLoginSession, path: string = astudioLoginSessionPath()): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    // `writeFileSync`'s mode is masked by the umask, so set it explicitly.
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}

/** Delete the stored sign-in, if any. */
export function clearLoginSession(path: string = astudioLoginSessionPath()): void {
  rmSync(path, { force: true })
}

/**
 * The identity fields of a stored sign-in, for the UI.
 *
 * Only what may leave the process: no cookie, no model key.
 */
export function describeLoginSession(session: AStudioLoginSession): AStudioWebLogin {
  return {
    source: 'dsh',
    accountId: session.accountId,
    ...(session.nickname === undefined ? {} : { nickname: session.nickname }),
    ...(session.avatar === undefined ? {} : { avatar: session.avatar }),
    loggedInAt: session.loggedInAt,
  }
}
