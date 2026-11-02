/**
 * WeChat QR sign-in against AStudio's SSO, without the AStudio app.
 *
 * The app's own flow, recovered from its bundle, is three plain HTTPS calls and
 * nothing else — no device fingerprint, no signature, no local service:
 *
 * 1. `GET sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd=<ticket>` mints a
 *    login ticket and answers a `mp.weixin.qq.com` QR image URL.
 * 2. `GET .../uids?fd=<ticket>` answers `code: -1` until someone scans, then
 *    `data.infoList[]` with `uid` and `ssoSessionId` per bound account.
 * 3. `GET agent.xfyun.cn/xingchen-studio/bot/models/configs` with that cookie
 *    answers the account's model rows, each carrying an `api_key` — the same
 *    string the app stores as `experimental_bearer_token`.
 *
 * So a sign-in here produces exactly the credential the rest of the plugin
 * already knows how to use, and the app need not be installed at all. What the
 * app contributed was a window to show the QR in, and that is now this.
 *
 * The QR image is fetched and re-encoded as a data URL rather than handed to the
 * browser as a WeChat link: the panel then loads nothing from a third-party
 * origin, which keeps the DSH page's own origin story intact.
 *
 * `fd` is the app's own identifier — eight characters from a reduced alphabet,
 * shape-checked here as well so a malformed value never reaches upstream. Its
 * ticket lives about a minute; that lifetime is tracked locally
 * ({@link ASTRO_WECHAT_QR_TTL_MS}) so an expired code is reported as expired
 * rather than as "still waiting" forever.
 *
 * @module dsh-astudio-connect/qr-login
 */

import { randomBytes } from 'node:crypto'
import { ASTRO_STUDIO_API_BASE } from './points.ts'
import type { AStudioLoginSession } from './login-session.ts'
import { describeLoginSession } from './login-session.ts'
import type { AStudioWebLogin, AStudioWebQrPoll, AStudioWebQrStart } from './status-paths.ts'

/** Production SSO origin (the app has a preproduction twin; this plugin does not). */
export const ASTRO_WECHAT_SSO_BASE = 'https://sso.xfyun.cn/'

/** The same origin as a value, for the `ssoUrl` check in a scan answer. */
const SSO_ORIGIN = new URL(ASTRO_WECHAT_SSO_BASE).origin

/** QR ticket path; `fd` is the only parameter. */
export const ASTRO_WECHAT_QR_PATH = 'SSOService/wx/scanlogin/qrcode'

/** Scan-status path, polled with the same `fd`. */
export const ASTRO_WECHAT_UIDS_PATH = 'SSOService/wx/scanlogin/uids'

/** How long a minted ticket is worth polling. */
export const ASTRO_WECHAT_QR_TTL_MS = 60_000

/** The ticket handle's accepted shape, as the app defines it. */
const FD_PATTERN = /^[A-Za-z0-9]{8}$/u

/**
 * Characters the app draws its ticket from.
 *
 * Not base64: the alphabet drops visually ambiguous glyphs (`I`, `l`, `0`, `1`,
 * `o`, `O`), which is a choice about typing a ticket by hand that this module
 * has no reason to second-guess.
 */
const FD_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'

/** Upstream code for "nobody has scanned yet". */
const CODE_PENDING = -1

/** Account code for a session upstream no longer accepts. */
const CODE_SESSION_INVALID = 80000

/** Model-configurations endpoint, resolved against the account API base. */
export const ASTRO_MODEL_CONFIGS_URL = new URL('bot/models/configs', ASTRO_STUDIO_API_BASE).toString()

/** Refuse to inline an image larger than this; a QR is a few tens of kilobytes. */
const MAX_IMAGE_BYTES = 512 * 1024

/** Default per-call timeout. */
const DEFAULT_TIMEOUT_MS = 10_000

/** One account bound to the scanning WeChat identity. */
export interface AStudioWechatAccount {
  accountId: string
  username?: string
}

/**
 * A scanned account plus its cookie.
 *
 * Internal on purpose: the public `select-account` answer lists ids only, and a
 * separate type is what stops the cookie from being serialized into a response
 * by accident.
 */
interface ScannedAccount extends AStudioWechatAccount {
  ssoSessionId: string
}

/** What one scan answered. */
interface WechatScan {
  accounts: ScannedAccount[]
  avatar?: string
}

/** Options for {@link createAStudioQrLogin}. */
export interface AStudioQrLoginOptions {
  /**
   * Persist a finished sign-in.
   *
   * Injected rather than imported so this module never decides where a
   * credential is stored — and so tests can watch what was written without
   * touching the real home directory.
   */
  save: (session: AStudioLoginSession) => void
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  /** Injected clock, for ticket-lifetime tests. */
  now?: () => number
  /** Per-call timeout. */
  timeoutMs?: number
}

/** The QR sign-in client the route drives. */
export interface AStudioQrLogin {
  /** Mint a ticket and fetch its QR image. */
  start(): Promise<AStudioWebQrStart>
  /** Read the scan state of a started ticket, and finish the sign-in on a scan. */
  poll(input: { fd: string, accountId?: string }): Promise<AStudioWebQrPoll>
}

/** Mint a ticket handle from the app's alphabet. */
export function createWechatFd(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, byte => FD_ALPHABET[byte % FD_ALPHABET.length]).join('')
}

/** Build one SSO URL with the ticket attached. */
function ssoUrl(pathname: string, fd: string): string {
  const url = new URL(pathname, ASTRO_WECHAT_SSO_BASE)
  url.searchParams.set('fd', fd)
  return url.toString()
}

/** A non-blank trimmed string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The envelope both SSO endpoints answer with. */
interface SsoEnvelope {
  code: number
  data?: unknown
}

/** Read one JSON answer; `undefined` for a transport failure or a non-JSON body. */
async function readJson(
  url: string,
  init: RequestInit,
  options: { fetchImpl: typeof fetch, timeoutMs: number },
): Promise<unknown> {
  try {
    const response = await options.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/** Narrow an unknown envelope, keeping only the `code` this module branches on. */
function envelopeOf(value: unknown): SsoEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const code = (value as Record<string, unknown>)['code']
  if (typeof code === 'number') return { code, data: (value as Record<string, unknown>)['data'] }
  if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) {
    return { code: Number(code), data: (value as Record<string, unknown>)['data'] }
  }
  return undefined
}

/**
 * Parse the scan answer into the accounts bound to that WeChat identity.
 *
 * An entry may carry `uid`/`ssoSessionId` directly or a `ssoUrl` pointing at
 * `/login/setcookies` with both as query parameters — the app accepts either,
 * so refusing the second shape would break accounts the app itself signs in.
 * An entry with neither is dropped rather than guessed at.
 */
export function parseWechatScan(data: unknown): WechatScan {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { accounts: [] }
  const record = data as Record<string, unknown>
  const avatar = text(record['headimgurl'])
  const raw = Array.isArray(record['infoList']) ? record['infoList'] : []
  const accounts: ScannedAccount[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    let accountId = text(row['uid']) ?? ''
    let ssoSessionId = text(row['ssoSessionId']) ?? ''
    const ssoUrl = text(row['ssoUrl'])
    if ((accountId === '' || ssoSessionId === '') && ssoUrl !== undefined) {
      try {
        const parsed = new URL(ssoUrl)
        if (parsed.origin === SSO_ORIGIN && parsed.pathname.replace(/\/+$/u, '') === '/login/setcookies') {
          accountId = accountId || (parsed.searchParams.get('account_id')?.trim() ?? '')
          ssoSessionId = ssoSessionId || (parsed.searchParams.get('ssoSessionId')?.trim() ?? '')
        }
      } catch {
        // A malformed URL is an unusable entry, not a reason to fail the scan.
      }
    }
    if (accountId === '' || ssoSessionId === '') continue
    const username = text(row['username'])
    accounts.push({
      accountId,
      ssoSessionId,
      ...(username === undefined ? {} : { username }),
    })
  }
  return { accounts, ...(avatar === undefined ? {} : { avatar }) }
}

/** The account cookie the account APIs take, in the app's own spelling. */
function accountCookie(accountId: string, ssoSessionId: string): string {
  return [
    `ssoSessionId=${ssoSessionId}`,
    `sso_sessionid=${ssoSessionId}`,
    `account_id=${accountId}`,
    `token=${ssoSessionId}`,
  ].join('; ')
}

/**
 * Create the QR sign-in client.
 *
 * Scan results are cached per ticket, because the app does too and for a plain
 * reason: once several accounts are bound, the user picks one over several
 * polls, and only the first poll is guaranteed to answer with the list.
 */
export function createAStudioQrLogin(options: AStudioQrLoginOptions): AStudioQrLogin {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** Ticket expiry, minted locally at start. */
  const expiry = new Map<string, number>()
  /** Scans that offered more than one account, kept for the selection press. */
  const scans = new Map<string, WechatScan>()

  function forget(fd: string): void {
    expiry.delete(fd)
    scans.delete(fd)
  }

  /**
   * Exchange a scanned ticket for a stored sign-in.
   *
   * The model-configurations call does double duty: it proves the cookie works
   * and it is where the model key comes from. An account with no `api_key` row
   * is signed in but unusable for inference, which is reported as
   * `no-credential` rather than as success — the shim would otherwise 401 on
   * the first message.
   */
  async function authenticate(
    account: ScannedAccount,
    avatar: string | undefined,
  ): Promise<AStudioWebQrPoll> {
    const payload = await readJson(ASTRO_MODEL_CONFIGS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: accountCookie(account.accountId, account.ssoSessionId),
      },
    }, { fetchImpl, timeoutMs })
    if (payload === undefined) return { status: 'unavailable' }

    const envelope = envelopeOf(payload)
    if (envelope === undefined) return { status: 'unavailable' }
    if (envelope.code === CODE_SESSION_INVALID) return { status: 'expired' }
    if (envelope.code !== 0) return { status: 'unavailable' }

    const rows = Array.isArray(envelope.data) ? envelope.data : []
    const modelBearerToken = pickModelKey(rows)
    if (modelBearerToken === undefined) return { status: 'no-credential' }

    const session: AStudioLoginSession = {
      version: 1,
      accountId: account.accountId,
      ssoSessionId: account.ssoSessionId,
      modelBearerToken,
      ...(account.username === undefined ? {} : { nickname: account.username }),
      ...(avatar === undefined ? {} : { avatar }),
      loginMethod: 'wechat-qr',
      loggedInAt: new Date(now()).toISOString(),
    }
    options.save(session)
    const login: AStudioWebLogin = describeLoginSession(session)
    return { status: 'authenticated', login }
  }

  return {
    async start(): Promise<AStudioWebQrStart> {
      // A ticket nobody came back for would otherwise sit in both maps until
      // this process exits: the expiry check only runs when a poll arrives, and
      // an abandoned code never gets one.
      const nowMs = now()
      for (const [staleFd, expiresAtMs] of expiry) {
        if (nowMs >= expiresAtMs) forget(staleFd)
      }

      const fd = createWechatFd()
      const answer = envelopeOf(await readJson(ssoUrl(ASTRO_WECHAT_QR_PATH, fd), {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }, { fetchImpl, timeoutMs }))
      if (answer === undefined || answer.code !== 0) return { status: 'unavailable' }

      const imageUrl = text(answer.data)
      if (imageUrl === undefined) return { status: 'unavailable' }
      try {
        const parsed = new URL(imageUrl)
        // The app insists on WeChat's own host; anything else is a redirect
        // this module will not follow with a data URL on the other end.
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'mp.weixin.qq.com') {
          return { status: 'unavailable' }
        }
      } catch {
        return { status: 'unavailable' }
      }

      let image: string
      try {
        const response = await fetchImpl(imageUrl, { signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return { status: 'unavailable' }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { status: 'unavailable' }
        const type = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
        if (!type.startsWith('image/')) return { status: 'unavailable' }
        image = `data:${type};base64,${bytes.toString('base64')}`
      } catch {
        return { status: 'unavailable' }
      }

      const expiresAtMs = now() + ASTRO_WECHAT_QR_TTL_MS
      expiry.set(fd, expiresAtMs)
      return { status: 'ok', fd, image, expiresAtMs }
    },

    async poll(input): Promise<AStudioWebQrPoll> {
      const { fd } = input
      // Shape check first: this value came from the browser, and a malformed
      // ticket is indistinguishable from an expired one to the caller.
      if (!FD_PATTERN.test(fd)) return { status: 'expired' }

      const expiresAtMs = expiry.get(fd)
      if (expiresAtMs === undefined || now() >= expiresAtMs) {
        forget(fd)
        return { status: 'expired' }
      }

      const selectedAccountId = input.accountId?.trim()
      const cached = selectedAccountId === undefined ? undefined : scans.get(fd)
      if (cached !== undefined && selectedAccountId !== undefined) {
        const chosen = cached.accounts.find(entry => entry.accountId === selectedAccountId)
        if (chosen !== undefined) {
          const result = await authenticate(chosen, cached.avatar)
          if (result.status === 'authenticated') forget(fd)
          return result
        }
      }

      const payload = envelopeOf(await readJson(ssoUrl(ASTRO_WECHAT_UIDS_PATH, fd), {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }, { fetchImpl, timeoutMs }))
      if (payload === undefined) return { status: 'unavailable' }
      if (payload.code === CODE_PENDING) return { status: 'pending' }
      if (payload.code !== 0) return { status: 'unavailable' }

      const scan = parseWechatScan(payload.data)
      if (scan.accounts.length === 0) return { status: 'unbound' }
      if (scan.accounts.length > 1) scans.set(fd, scan)

      const chosen = selectedAccountId === undefined
        ? (scan.accounts.length === 1 ? scan.accounts[0] : undefined)
        : scan.accounts.find(entry => entry.accountId === selectedAccountId)
      if (chosen === undefined) {
        return {
          status: 'select-account',
          accounts: scan.accounts.map(account => ({
            accountId: account.accountId,
            ...(account.username === undefined ? {} : { username: account.username }),
          })),
          ...(scan.avatar === undefined ? {} : { avatar: scan.avatar }),
        }
      }

      const result = await authenticate(chosen, scan.avatar)
      if (result.status === 'authenticated') forget(fd)
      return result
    },
  }
}

/**
 * Pick the model key out of the account's model rows.
 *
 * Same order the app uses — current, then default, then first — because the
 * "current" row is the one AStudio itself is configured to chat with, and a
 * different key would bill a different configuration.
 */
export function pickModelKey(rows: readonly unknown[]): string | undefined {
  const usable = rows.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row),
  )
  const current = usable.find(row => row['is_current'] === true)
  const fallback = usable.find(row => row['is_default'] === true)
  for (const row of [current, fallback, usable[0]]) {
    const key = text(row?.['api_key'])
    if (key !== undefined) return key
  }
  return undefined
}
