/**
 * Daily-reward claim route: `POST /astudio/claim`, pressed from the points
 * section in Settings. No body, no parameters — the account service decides
 * whether today holds a reward, and the answer is a named state either way.
 *
 * This is the plugin's only route that changes something on the account side,
 * so it carries all three guards the other write routes use:
 *
 * 1. **Loopback Host** — drops DNS-rebinding pages, whose requests arrive
 *    addressed to the attacker's domain.
 * 2. **Loopback Origin** — a cross-site `fetch` can reach `127.0.0.1`, and a
 *    booking made on the user's behalf by another page is exactly what the
 *    Origin header rules out.
 * 3. **The in-process control key** — loopback alone is not authentication (any
 *    local process can write `Host: 127.0.0.1`), so the caller has to prove it
 *    was handed the key that ships inside the same-origin status document.
 *
 * Idempotency is the upstream's: completing a popup twice answers `11003002`,
 * which {@link AStudioDailyRewardClient} reads as "already claimed". A wrong
 * press therefore cannot mint credit, which is why this route needs no lock of
 * its own — two simultaneous presses both end up at one booking.
 *
 * @module dsh-astudio-connect/claim-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioDailyRewardClient } from './daily-reward.ts'
import { controlKeyMatches, readControlKey } from './control-key.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { ASTRO_CLAIM_PATH } from './status-paths.ts'

export { ASTRO_CLAIM_PATH }

/** Constructor dependencies. */
export interface AStudioClaimRouteOptions {
  client: AStudioDailyRewardClient
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The answer describes one booking; a cached copy would report the credit
    // of an earlier day.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/**
 * The claim handler, extracted so tests can mount it on a bare server with a
 * known key.
 */
export function astudioClaimHandler(
  options: AStudioClaimRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    if (!controlKeyMatches(key, readControlKey(req.headers))) {
      json(res, 403, { error: 'invalid-control-key' })
      return
    }
    // `claim` maps every failure to a named state, so this route has no error
    // branch of its own: a document always comes back.
    const result = await options.client.claim()
    json(res, 200, result)
  }
}

/** Mount the claim route on the host web server. */
export function registerAStudioClaimRoute(
  ctx: Context,
  options: AStudioClaimRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_CLAIM_PATH,
      handler: astudioClaimHandler(options, key),
    })
    return () => {
      dispose()
    }
  })
}
