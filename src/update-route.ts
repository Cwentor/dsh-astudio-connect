/**
 * Same-origin update route for the AStudio plugin card: public version
 * metadata only (npm dist-tags + GitHub release list), loopback-gated exactly
 * like the status route, GET-only, never carrying credentials.
 *
 * @module dsh-astudio-connect/update-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { checkAStudioUpdate, ASTRO_UPDATE_TIMEOUT_MS, type AStudioUpdateFetch, type AStudioUpdateResult } from './update.ts'

/** Update route path. */
export const ASTRO_UPDATE_PATH = '/astudio/update'

/** Constructor dependencies. */
export interface AStudioUpdateRouteOptions {
  currentVersion: string
  fetchImpl?: AStudioUpdateFetch
  timeoutMs?: number
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/** The same browser-origin gate the status route uses: DNS-rebinding pages die here. */
function browserRequestAllowed(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** Build the route handler; the caller owns registration and disposal. */
export function astudioUpdateHandler(options: AStudioUpdateRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!browserRequestAllowed(req)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    let result: AStudioUpdateResult
    try {
      result = await checkAStudioUpdate({
        currentVersion: options.currentVersion,
        ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
        timeoutMs: options.timeoutMs ?? ASTRO_UPDATE_TIMEOUT_MS,
      })
    } catch {
      // The checker itself fails closed, but a thrown seam must still answer
      // a well-formed document rather than an empty 500.
      result = { status: 'unavailable', currentVersion: options.currentVersion, reason: 'registry-unavailable' }
    }
    json(res, 200, result)
  }
}

/** Register the update route on the optional host web server. */
export function registerAStudioUpdateRoute(ctx: Context, options: AStudioUpdateRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_UPDATE_PATH,
      handler: astudioUpdateHandler(options),
    })
    return () => {
      dispose()
    }
  })
}
