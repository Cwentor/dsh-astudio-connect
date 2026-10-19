/**
 * Same-origin points route for the composer badge: the account's two credit
 * pools, fetched by the browser half on mount and on an explicit ↻. Loopback
 * Host/Origin gated exactly like the status route, GET only, and it never
 * carries the session credential it reads those pools with.
 *
 * @module dsh-astudio-connect/points-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioPointsClient } from './points.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { ASTRO_POINTS_PATH } from './status-paths.ts'

export { ASTRO_POINTS_PATH }

/** Constructor dependencies. */
export interface AStudioPointsRouteOptions {
  client: AStudioPointsClient
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // A balance is live state: a cached copy would report a stale number.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/** The same browser-origin gate the status route uses: DNS-rebinding pages die here. */
function browserRequestAllowed(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * Whether this read must reach upstream instead of the TTL cache.
 *
 * The badge's ↻ is the only writer of this flag; a mount read leaves it off so
 * opening several sessions in a row does not bill the account service once per
 * composer.
 */
function wantsFreshRead(url: string | undefined): boolean {
  if (url === undefined) return false
  const query = url.split('?')[1]
  if (query === undefined) return false
  return new URLSearchParams(query).get('refresh') === '1'
}

/** Build the route handler; the caller owns registration and disposal. */
export function astudioPointsHandler(options: AStudioPointsRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!browserRequestAllowed(req)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    // `read` maps every failure to a named state, so this route has no error
    // branch of its own: a document always comes back.
    const result = await options.client.read({ fresh: wantsFreshRead(req.url) })
    json(res, 200, result)
  }
}

/** Register the points route on the host web server. */
export function registerAStudioPointsRoute(ctx: Context, options: AStudioPointsRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_POINTS_PATH,
      handler: astudioPointsHandler(options),
    })
    return () => {
      dispose()
    }
  })
}
