/**
 * AStudio loopback shim. Serves an OpenAI-compatible endpoint on 127.0.0.1
 * that the pi-ai provider points to. The shim validates four inbound guards
 * (loopback Host, loopback Origin, JSON Content-Type, shared-secret Bearer),
 * then forwards the request to maas-api via the upstream client.
 *
 * @module dsh-astudio-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { AStudioCredentialStore } from './auth.ts'
import type { AStudioCatalog, AStudioModelInfo } from './catalog.ts'
import type { AStudioUpstreamResult, UpstreamErrorKind } from './upstream.ts'
import type { AStudioUpstreamClient } from './upstream.ts'

/** Minimal logger surface. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface AStudioShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /** The per-process shared secret the plugin's own client must carry. */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface AStudioShimOptions {
  store: AStudioCredentialStore
  upstream: AStudioUpstreamClient
  catalog: AStudioCatalog
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  auth: 401,
  not_found: 502,
  rate: 429,
  server: 502,
  client: 400,
}

/** Check the Host header names a loopback interface. */
function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false
  const h = host.split(':')[0]?.toLowerCase() ?? ''
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/** Check the Origin header is loopback (or absent for non-browser clients). */
function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true // non-browser clients don't send Origin
  const o = origin.split(':')[0]?.toLowerCase() ?? ''
  return o === 'http' || o === 'https'
    ? origin.includes('127.0.0.1') || origin.includes('localhost') || origin.includes('[::1]')
    : false
}

/** Check the Content-Type is application/json. */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** Read a request body with a size cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
export function createAStudioShim(options: AStudioShimOptions): AStudioShim {
  const { store, upstream, catalog } = options
  const logger = options.logger

  // Per-process shared secret. The adapter resolves this as the OpenAI
  // apiKey, which pi-ai sends as `Authorization: Bearer ...`. The shim
  // validates this before forwarding and resolves the real AStudio token
  // itself via the store.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready: Promise<void> = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('astudio shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      // Browser-sent origins must be loopback too.
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      // Shared-secret bearer.
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        const models = catalog.current().map((m: AStudioModelInfo) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'astudio',
        }))
        writeJson(res, 200, { object: 'list', data: models })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    let credential: string | undefined
    try {
      credential = store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (credential === undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', 'AStudio token not available')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const body = JSON.parse(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const result: AStudioUpstreamResult = await upstream.chat(credential, body, controller.signal)

    if (!result.ok) {
      const detail = result.message.slice(0, 400)
      const kind = result.kind as UpstreamErrorKind
      writeOpenAIError(res, KIND_STATUS[kind], kind, `astudio upstream ${kind}: ${detail}`)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const bodyStream = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    bodyStream.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    bodyStream.on('error', (error: unknown) => {
      logger?.warn('dsh-astudio-connect: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    bodyStream.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
