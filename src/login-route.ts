/**
 * Sign-in routes: `POST /astudio/login/qr` (mint a ticket), `POST
 * /astudio/login/qr/poll` (collect it), `POST /astudio/login/logout`.
 *
 * All three are writes, and the poll is the heaviest one in the plugin: it is
 * what turns a scanned ticket into a stored credential that every other route
 * then reads. So they carry the same three guards as the claim route — loopback
 * Host, loopback Origin, and the in-process control key — and none of them takes
 * a parameter that could redirect the exchange anywhere else.
 *
 * The poll answer is a named state, never an exception: "nobody scanned yet" is
 * the expected answer for most of the ticket's life, and a 500 for it would be
 * noise the panel has to decode.
 *
 * @module dsh-astudio-connect/login-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioQrLogin } from './qr-login.ts'
import type { AStudioWebLogin } from './status-paths.ts'
import { controlKeyMatches, readControlKey } from './control-key.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import {
  ASTRO_LOGIN_QR_PATH,
  ASTRO_LOGIN_QR_POLL_PATH,
  ASTRO_LOGOUT_PATH,
} from './status-paths.ts'

export { ASTRO_LOGIN_QR_PATH, ASTRO_LOGIN_QR_POLL_PATH, ASTRO_LOGOUT_PATH }

/** Largest body accepted; the poll carries two short strings. */
const MAX_BODY_BYTES = 1024

/** Constructor dependencies. */
export interface AStudioLoginRouteOptions {
  client: AStudioQrLogin
  /**
   * Run after a sign-in has been stored.
   *
   * The host uses it to drop cached credentials, re-read the model roster and
   * tell the browser the catalog moved — a fresh sign-in usually changes both
   * the token and the models it can reach.
   */
  onAuthenticated?: (login: AStudioWebLogin) => void
  /** Forget the plugin's own sign-in. */
  signOut: () => Promise<void>
  /** Run after a sign-out, for the same reason as {@link onAuthenticated}. */
  onSignedOut?: () => void
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Every answer describes the state of one attempt; a cached copy would let
    // a later page believe a QR was current when it had already expired.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/** Read the request body with a hard ceiling; `undefined` means "too large". */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The poll body: a ticket and, once the user has chosen, an account id. */
interface PollBody {
  fd: string
  accountId?: string
}

/**
 * Parse `{ fd, accountId? }`.
 *
 * A missing ticket is a malformed request rather than an expired one — the
 * distinction matters because "expired" makes the panel start over, and it
 * should not do that on a request that never named a ticket.
 */
export function pollBodyFrom(text: string | undefined): PollBody | undefined {
  if (text === undefined || text.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const fd = record['fd']
  if (typeof fd !== 'string' || fd.trim() === '') return undefined
  const accountId = record['accountId']
  return {
    fd: fd.trim(),
    ...(typeof accountId === 'string' && accountId.trim() !== '' ? { accountId: accountId.trim() } : {}),
  }
}

/** The shared guard: POST, loopback Host and Origin, control key. */
function admit(req: IncomingMessage, res: ServerResponse, key: string): boolean {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method-not-allowed' })
    return false
  }
  if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
    json(res, 403, { error: 'forbidden' })
    return false
  }
  if (!controlKeyMatches(key, readControlKey(req.headers))) {
    json(res, 403, { error: 'invalid-control-key' })
    return false
  }
  return true
}

/** Handler for `POST /astudio/login/qr`: mint a ticket and its QR image. */
export function astudioQrStartHandler(
  options: AStudioLoginRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admit(req, res, key)) return
    json(res, 200, await options.client.start())
  }
}

/** Handler for `POST /astudio/login/qr/poll`: read a ticket, finish on a scan. */
export function astudioQrPollHandler(
  options: AStudioLoginRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admit(req, res, key)) return
    const body = pollBodyFrom(await readBody(req))
    if (body === undefined) {
      json(res, 400, { error: 'invalid-body' })
      return
    }
    const result = await options.client.poll(body)
    if (result.status === 'authenticated') {
      // The credential is already on disk; the callback only re-reads what the
      // host had cached, so a failure here must not turn a good sign-in into an
      // error the panel would report as a failed scan.
      try {
        options.onAuthenticated?.(result.login)
      } catch {
        // Nothing here is worth failing the answer for.
      }
    }
    json(res, 200, result)
  }
}

/** Handler for `POST /astudio/login/logout`: forget the plugin's own sign-in. */
export function astudioLogoutHandler(
  options: AStudioLoginRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admit(req, res, key)) return
    await options.signOut()
    try {
      options.onSignedOut?.()
    } catch {
      // Same reasoning as the sign-in callback.
    }
    json(res, 200, { status: 'ok' })
  }
}

/** Mount the three login routes on the host web server. */
export function registerAStudioLoginRoutes(
  ctx: Context,
  options: AStudioLoginRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const disposeStart = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_LOGIN_QR_PATH,
      handler: astudioQrStartHandler(options, key),
    })
    const disposePoll = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_LOGIN_QR_POLL_PATH,
      handler: astudioQrPollHandler(options, key),
    })
    const disposeLogout = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_LOGOUT_PATH,
      handler: astudioLogoutHandler(options, key),
    })
    return () => {
      disposePoll()
      disposeStart()
      disposeLogout()
    }
  })
}
