/**
 * Same-origin status route for the AStudio plugin card: connection state,
 * catalog provenance, hidden-model state, and probe summary, fetched by the
 * browser half. The route answers loopback browser requests only and never
 * carries token material.
 *
 * @module dsh-astudio-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioAuthStatus, AStudioCredentialStore } from './auth.ts'
import type { AStudioCatalog } from './catalog.ts'
import type { AStudioProbeRecord, AStudioProbeStore } from './probe-store.ts'
import { ASTRO_LOCAL_IDENTITY } from './identity.ts'
import { hostIsLoopback } from './loopback.ts'
import {
  ASTRO_STATUS_PATH,
  type AStudioWebLogin,
  type AStudioWebProbe,
  type AStudioWebStatus,
} from './status-paths.ts'

/** Status store surface — the credential store plus the sign-in summary. */
export interface AStudioStatusStore extends AStudioCredentialStore {
  status(): Promise<AStudioAuthStatus>
  /**
   * Which sign-in is in use.
   *
   * Optional so a store that predates the QR flow still satisfies the type; the
   * section then reads the source as unknown and offers the QR sign-in anyway.
   */
  login?(): AStudioWebLogin
}

/** Options for the status route. */
export interface AStudioStatusRouteOptions {
  store: AStudioStatusStore
  catalog: AStudioCatalog
  /** Probe store used to assemble the current identity's probe summary. */
  probe?: AStudioProbeStore
  /** Identity used for the probe summary. Defaults to the local identity. */
  identity?: string
  /**
   * In-process control key handed to the browser card, which echoes it back as
   * `x-astudio-control-key` on every control write (probe, model visibility).
   * Absent when the write routes are unwired.
   */
  controlKey?: string
}

/** Assemble the probe summary for one identity from the live catalog. */
function buildProbe(catalog: AStudioCatalog, probe: AStudioProbeStore, identity: string): AStudioWebProbe {
  const results: AStudioWebProbe['results'] = []
  for (const model of catalog.current()) {
    const record: AStudioProbeRecord | undefined = probe.get(identity, model.id)
    if (record === undefined) continue
    results.push({
      modelId: record.modelId,
      validation: record.validation,
      efforts: [...record.efforts],
      expiresAtMs: record.expiresAtMs,
    })
  }
  return { account: identity, results }
}

/**
 * Mount the GET status route on the host web server.
 *
 * The route serves a JSON document with connection state, catalog provenance,
 * hidden models, and probe observations. It checks the loopback Host header
 * before answering.
 */
export function registerAStudioStatusRoute(ctx: Context, options: AStudioStatusRouteOptions): void {
  const { store, catalog } = options
  const identity = options.identity ?? ASTRO_LOCAL_IDENTITY

  // Registered through `ctx.effect` like every other route in this bundle.
  // Without it the registration is never released when the plugin is disposed,
  // and the next mount — a live patch reload, or `dsh plugin add` — died on
  // `webserver: duplicate exact route "/astudio/status"` before it could
  // register anything else. Since this route is mounted first, that one leaked
  // handler took the claim, points, login and probe routes down with it
  // (measured 2026-11-05).
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ASTRO_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Loopback check. The shared predicate covers every loopback spelling the
        // host can be reached on — including `[::1]:<port>`, which a split on ':'
        // reduced to `[` and rejected.
        if (!hostIsLoopback(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'forbidden' }))
          return
        }

        const authStatus = await store.status()
        // Reported alongside the credential state rather than inside it: "signed
        // in" and "signed in with which sign-in" are different questions, and the
        // panel answers them in different places.
        let login: AStudioWebLogin | undefined
        try {
          login = store.login?.()
        } catch {
          login = undefined
        }
        const models = catalog.current()
        const failure = catalog.failure()
        const probe: AStudioWebProbe = options.probe === undefined
          ? { account: identity, results: [] }
          : buildProbe(catalog, options.probe, identity)

        const body: AStudioWebStatus = {
          auth: {
            state: authStatus.state,
            ...(authStatus.tokenLength !== undefined ? { tokenLength: authStatus.tokenLength } : {}),
          },
          catalog: {
            source: catalog.source(),
            modelCount: models.length,
            models: models.map(m => ({ id: m.id, name: m.name })),
            // An empty roster is a state the card must explain, not a blank list.
            ...(failure !== undefined ? { failure } : {}),
          },
          visibility: {
            hidden: [...catalog.hiddenModelIds()],
          },
          probe,
          ...(login === undefined ? {} : { login }),
          ...(options.controlKey !== undefined ? { controlKey: options.controlKey } : {}),
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      },
    })
    return dispose
  })
}
