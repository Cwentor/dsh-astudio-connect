/**
 * AStudio reasoning-probe route. The browser half of the settings card posts to
 * `POST /astudio/probe/{modelId}` to run a probe for one model. Two guards stop
 * different things:
 *
 * 1. **Loopback Host**, shared with the status route. This drops DNS-rebinding
 *    pages, whose requests arrive addressed to the attacker's domain.
 * 2. **An in-process shared key**, minted per process and handed only to the
 *    same-origin card. Loopback alone is not authentication — any local process
 *    can write `Host: 127.0.0.1` — so a route that spends a request against the
 *    upstream must prove the caller was told the key.
 *
 * The request body may name an `effort`; when absent, probing uses `low`. The
 * route never returns token material or the raw upstream body.
 *
 * @module dsh-astudio-connect/probe-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AStudioProbeService } from './probe-service.ts'

/** Probe control route prefix; the model id is the trailing path segment. */
export const ASTRO_PROBE_PATH = '/astudio/probe'

/** Header carrying the in-process probe key. */
const PROBE_KEY_HEADER = 'x-astudio-probe-key'

/** Default effort used when the request body names none. */
const DEFAULT_PROBE_EFFORT = 'low'

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Constructor dependencies. */
export interface AStudioProbeRouteOptions {
  /** Run a probe for one model, carrying only consent and an optional signal. */
  service: AStudioProbeService
  /** Drop the adapter's catalog snapshot after a probe completed. */
  invalidate?: () => void
}

/** Mint the per-process probe key. */
export function createAStudioProbeKey(): string {
  return randomBytes(24).toString('hex')
}

/** Check the Host header names a loopback interface. */
function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false
  const h = host.split(':')[0]?.toLowerCase() ?? ''
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
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
  const prefix = `${ASTRO_PROBE_PATH}/`
  if (!path.startsWith(prefix)) return undefined
  const modelId = path.slice(prefix.length)
  return modelId === '' ? undefined : modelId
}

/** Parse an optional `{ effort }` body; invalid bodies fall back to the default. */
function effortFromBody(text: string | undefined): string {
  if (text === undefined || text.trim() === '') return DEFAULT_PROBE_EFFORT
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_PROBE_EFFORT
    const effort = (parsed as Record<string, unknown>).effort
    return typeof effort === 'string' && effort.trim() !== '' ? effort : DEFAULT_PROBE_EFFORT
  } catch {
    return DEFAULT_PROBE_EFFORT
  }
}

/**
 * The probe handler, extracted so tests can mount it on a bare server with a
 * known key.
 */
export function astudioProbeHandler(
  deps: AStudioProbeRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'host-not-loopback' })
      return
    }
    if (!keyMatches(key, req.headers[PROBE_KEY_HEADER] as string | undefined)) {
      json(res, 403, { error: 'invalid-probe-key' })
      return
    }
    const modelId = modelFromUrl(req.url)
    if (modelId === undefined) {
      json(res, 404, { error: 'missing-model-id' })
      return
    }

    const effort = effortFromBody(await readBody(req))
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const result = await deps.service.probe(modelId, effort, true, controller.signal)
    if (result.state === 'ok') {
      deps.invalidate?.()
    }

    const response: Record<string, unknown> = {
      state: result.state,
      efforts: result.efforts,
    }
    if (result.validation !== undefined) response.validation = result.validation
    if (result.reason !== undefined) response.reason = result.reason
    json(res, 200, response)
  }
}

/** Mount the probe route on an optional webServer context. */
export function registerAStudioProbeRoute(
  ctx: Context,
  deps: AStudioProbeRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ASTRO_PROBE_PATH,
      handler: astudioProbeHandler(deps, key),
    })
    return () => dispose()
  })
}
