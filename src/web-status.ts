/**
 * Same-origin status route for the AStudio plugin card: connection state and
 * model count, fetched by the browser half. The route answers loopback
 * browser requests only and never carries token material.
 *
 * @module dsh-astudio-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioCredentialStore } from './auth.ts'
import type { AStudioCatalog } from './catalog.ts'

/** Status route path. */
export const ASTRO_STATUS_PATH = '/astudio/status'

/** Options for the status route. */
export interface AStudioStatusRouteOptions {
  store: AStudioCredentialStore
  catalog: AStudioCatalog
}

/** What the status route serves. */
export interface AStudioWebStatus {
  connected: boolean
  modelCount: number
  models: Array<{ id: string; name: string }>
}

/**
 * Mount the GET status route on the host web server.
 *
 * The route serves a JSON document with connection state and model list.
 * It checks the loopback Host header before answering.
 */
export function registerAStudioStatusRoute(ctx: Context, options: AStudioStatusRouteOptions): void {
  const { store, catalog } = options

  ctx.webServer.register({
    kind: 'exact',
    path: ASTRO_STATUS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      // Loopback check
      const host = req.headers.host ?? ''
      const hostName = host.split(':')[0]?.toLowerCase() ?? ''
      if (hostName !== '127.0.0.1' && hostName !== 'localhost') {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }

      const token = store.resolve()
      const connected = token !== undefined
      const models = catalog.current()

      const body: AStudioWebStatus = {
        connected,
        modelCount: models.length,
        models: models.map(m => ({ id: m.id, name: m.name })),
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    },
  })
}
