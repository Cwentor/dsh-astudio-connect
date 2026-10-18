/**
 * Same-origin update route for the AStudio plugin card: public package metadata
 * only, loopback-gated exactly like the status route, GET-only, never carrying
 * credentials or internal file paths.
 *
 * @module dsh-astudio-connect/update-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ASTRO_PACKAGE_NAME, ASTRO_REPOSITORY_URL, ASTRO_VERSION } from './version.ts'

/** Update route path. */
export const ASTRO_UPDATE_PATH = '/astudio/update'

/** Public package metadata the update route serves. */
export interface AStudioUpdateInfo {
  package: string
  version: string
  repository: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Check the Host header names a loopback interface. */
function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false
  const h = host.split(':')[0]?.toLowerCase() ?? ''
  return h === '127.0.0.1' || h === 'localhost'
}

/** Build the route handler; the caller owns registration and disposal. */
export function astudioUpdateHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    const body: AStudioUpdateInfo = {
      package: ASTRO_PACKAGE_NAME,
      version: ASTRO_VERSION,
      repository: ASTRO_REPOSITORY_URL,
    }
    json(res, 200, body)
  }
}

/** Register the update route on the optional host web server. */
export function registerAStudioUpdateRoute(ctx: Context): void {
  ctx.webServer.register({
    kind: 'exact',
    path: ASTRO_UPDATE_PATH,
    handler: astudioUpdateHandler(),
  })
}
