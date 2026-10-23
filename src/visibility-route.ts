/**
 * AStudio model-visibility route. The settings card posts to
 * `POST /astudio/visibility/{modelId}` with `{ visible: boolean }` to decide
 * whether one model is offered to DSH, and reads the current answer back from
 * the status document's `visibility.hidden` list.
 *
 * Two guards, both inherited from the probe route's reasoning:
 *
 * 1. **Loopback Host** — drops DNS-rebinding pages, whose requests arrive
 *    addressed to the attacker's domain.
 * 2. **The in-process control key** — loopback alone is not authentication (any
 *    local process can write `Host: 127.0.0.1`), and this route edits a file
 *    under the DSH home, so the caller has to prove it was handed the key.
 *
 * Hiding filters `adapter.listModels`, which is what the picker renders. The
 * adapter reads the hidden list on every call, so the write lands immediately —
 * but the **browser** caches one model catalog per host generation and only
 * reloads it when the host publishes `llm/adapters-updated`. Writing without
 * that announcement left the hidden model in the picker, where choosing it
 * failed with `session/model-unavailable`: the picker was offering an entry the
 * catalog no longer contained. Hence `notify`, called once per accepted write.
 *
 * A hidden model that a session already has selected stays readable in history,
 * but the selection is no longer routable, so that session has to pick another
 * model before it can send again. That is unavoidable here: `listModels` is
 * per provider, not per session, so it cannot exempt the one model in use.
 *
 * A model id outside the current roster is refused rather than persisted: the
 * roster is the only thing that can be shown again, so writing an id it does
 * not contain would leave an entry the card could never offer to re-enable.
 *
 * @module dsh-astudio-connect/visibility-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioCatalog } from './catalog.ts'
import type { AStudioVisibilityStore } from './visibility-store.ts'
import { controlKeyMatches, readControlKey } from './control-key.ts'
import { ASTRO_LOCAL_IDENTITY } from './identity.ts'
import { hostIsLoopback } from './loopback.ts'
import { ASTRO_VISIBILITY_PATH } from './status-paths.ts'

/** Visibility control route prefix; the model id is the trailing path segment. */
export { ASTRO_VISIBILITY_PATH }

/** Largest control body accepted; this payload is one boolean. */
const MAX_BODY_BYTES = 1024

/** Constructor dependencies. */
export interface AStudioVisibilityRouteOptions {
  /** Roster the requested model id must belong to. */
  catalog: AStudioCatalog
  /** Persistence for the per-identity hidden list. */
  store: AStudioVisibilityStore
  /** Identity whose visibility is edited. Defaults to the local identity. */
  identity?: string
  /**
   * Called after a write lands, to make the browser re-read the model catalog.
   * Kept a callback so this route stays ignorant of how the host advertises
   * changes (see the module note).
   */
  notify?: () => void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
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

/** Extract the model id from the trailing path segment, ignoring any query. */
function modelFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const path = url.split('?')[0] ?? ''
  const prefix = `${ASTRO_VISIBILITY_PATH}/`
  if (!path.startsWith(prefix)) return undefined
  const modelId = path.slice(prefix.length)
  return modelId === '' ? undefined : modelId
}

/**
 * Parse the `{ visible }` body. Returns `undefined` for anything else: a
 * missing or non-boolean flag is a malformed request, not a default.
 */
function visibleFromBody(text: string | undefined): boolean | undefined {
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const visible = (parsed as Record<string, unknown>).visible
    return typeof visible === 'boolean' ? visible : undefined
  } catch {
    return undefined
  }
}

/**
 * The visibility handler, extracted so tests can mount it on a bare server with
 * a known key.
 */
export function astudioVisibilityHandler(
  deps: AStudioVisibilityRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const identity = deps.identity ?? ASTRO_LOCAL_IDENTITY
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'host-not-loopback' })
      return
    }
    if (!controlKeyMatches(key, readControlKey(req.headers))) {
      json(res, 403, { error: 'invalid-control-key' })
      return
    }
    const modelId = modelFromUrl(req.url)
    if (modelId === undefined) {
      json(res, 404, { error: 'missing-model-id' })
      return
    }
    if (!deps.catalog.current().some(model => model.id === modelId)) {
      json(res, 404, { error: 'unknown-model' })
      return
    }

    const visible = visibleFromBody(await readBody(req))
    if (visible === undefined) {
      json(res, 400, { error: 'invalid-body' })
      return
    }

    try {
      await deps.store.setVisible(identity, modelId, visible)
    } catch {
      json(res, 500, { error: 'write-failed' })
      return
    }

    // The write is durable before this runs, so a listener failure must not turn
    // a successful save into an error response.
    try {
      deps.notify?.()
    } catch {
      // Ignored: the preference is saved; the next catalog read will show it.
    }

    json(res, 200, { modelId, visible })
  }
}

/** Mount the visibility route on the host web server. */
export function registerAStudioVisibilityRoute(
  ctx: Context,
  deps: AStudioVisibilityRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ASTRO_VISIBILITY_PATH,
      handler: astudioVisibilityHandler(deps, key),
    })
    return () => dispose()
  })
}
