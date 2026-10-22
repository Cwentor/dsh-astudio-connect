/**
 * AStudio loopback shim. Serves an OpenAI-compatible endpoint on 127.0.0.1
 * that the pi-ai provider points to. The shim validates four inbound guards
 * (loopback Host, loopback Origin, JSON Content-Type, shared-secret Bearer),
 * then forwards the request to maas-api via the upstream client.
 *
 * Routes, in short: `GET /healthz` (liveness), `GET /v1/models` (catalog with
 * hidden entries filtered out), `POST /v1/chat/completions` (forwarded with
 * the body and the SSE stream passed through). Bodies are capped at 64 MB and
 * a stream may sit idle for 300 s before it is aborted.
 *
 * Port note: binding retries (see loopback.ts) because the OS can hand out a
 * port that fetch refuses to connect to — the listen succeeds while every
 * request fails with `TypeError: fetch failed`.
 *
 * @module dsh-astudio-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { AStudioCredentialStore } from './auth.ts'
import type { AStudioCatalog, AStudioModelInfo } from './catalog.ts'
import type { AStudioUpstreamResult, UpstreamErrorKind } from './upstream.ts'
import type { AStudioUpstreamClient } from './upstream.ts'
import { diagnoseRefusal, SAFE_MAX_TOKENS, toolNameOf } from './diagnose.ts'
import type { Diagnosis } from './diagnose.ts'
import { bindToUsablePort, hostIsLoopback, originIsLoopback } from './loopback.ts'

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
 * Optional request fields an OpenAI-compatible *gateway* may reject outright.
 *
 * They all come from the OpenAI platform (storage, prompt caching, tiering),
 * not from the chat-completions protocol itself, so a gateway that validates
 * its schema strictly is entitled to refuse them — and gives an opaque 400
 * instead of naming the offending one.
 */
const GATEWAY_OPTIONAL_FIELDS = [
  'store',
  'stream_options',
  'prompt_cache_key',
  'prompt_cache_retention',
  'service_tier',
  'parallel_tool_calls',
  'metadata',
] as const

/**
 * A request shape the shim can fall back to.
 *
 * `as-is` is what pi-ai emits. The two fallbacks are tried in order, only
 * after the gateway answered 400 to the previous shape.
 */
export type GatewayShape = 'as-is' | 'optional-fields' | 'text-only-content'

/** Fallback shapes, most conservative last. */
export const GATEWAY_SHAPE_FALLBACKS: readonly GatewayShape[] = ['optional-fields', 'text-only-content']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuild a chat/completions body in a more conservative shape.
 *
 * Narrowing is deliberately limited to what the wire format itself does not
 * require: platform-only fields, the OpenAI-only `developer` role (answered as
 * `system`, which every server understands), and text-only content arrays
 * (flattened to a string) in the final fallback. Anything that would change
 * what the model receives — tools, reasoning effort, sampling — is untouched.
 *
 * @param body - Parsed request body.
 * @param shape - Target shape; `as-is` returns the body untouched.
 * @returns The narrowed body, or the original value when it is not an object.
 */
export function sanitizeGatewayBody(body: unknown, shape: GatewayShape): unknown {
  if (shape === 'as-is' || !isRecord(body)) return body

  const next: Record<string, unknown> = { ...body }
  for (const field of GATEWAY_OPTIONAL_FIELDS) delete next[field]

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message: unknown) => {
      if (!isRecord(message)) return message
      const role = message.role === 'developer' ? 'system' : message.role
      const retitled: Record<string, unknown> = role === message.role ? message : { ...message, role }
      if (shape !== 'text-only-content' || !Array.isArray(message.content)) return retitled

      const parts = message.content
      const textOnly = parts.every(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      if (!textOnly) return retitled
      return { ...retitled, content: parts.map(part => (part as { text: string }).text).join('\n\n') }
    })
  }

  return next
}

/**
 * Fix wire-format mistakes that make a body invalid for *every* server.
 *
 * These are not gateway quirks: `arguments` must be a JSON string, a tool
 * result must name its call, and content must not be null. maas-api answers
 * each of them with the same opaque `10005 invalid request`, verified against
 * the live gateway, so repairing them is always right and never changes what
 * the model sees.
 *
 * @returns The repaired body and a list of what was changed, for logging.
 */
export function repairChatBody(body: unknown): { body: unknown, repairs: string[] } {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, repairs: [] }

  const repairs: string[] = []
  const messages: unknown[] = []

  for (const message of body.messages) {
    if (!isRecord(message)) {
      messages.push(message)
      continue
    }

    const repaired: Record<string, unknown> = { ...message }

    // A tool result with no call id cannot be paired with anything.
    if (repaired.role === 'tool' && (typeof repaired.tool_call_id !== 'string' || repaired.tool_call_id === '')) {
      repairs.push('dropped a tool result with no tool_call_id')
      continue
    }

    // Null content is rejected; an empty string is the same thing, validly.
    if (repaired.content === null || repaired.content === undefined) {
      if (repaired.role === 'tool' || repaired.role === 'assistant') {
        repaired.content = ''
        repairs.push(`replaced null content with "" on a ${String(repaired.role)} message`)
      }
    }

    if (Array.isArray(repaired.tool_calls)) {
      const calls: unknown[] = []
      for (const call of repaired.tool_calls) {
        if (!isRecord(call) || typeof call.id !== 'string' || call.id === '') {
          repairs.push('dropped a tool call with no id')
          continue
        }
        const fn = isRecord(call.function) ? call.function : undefined
        if (fn === undefined) {
          repairs.push('dropped a tool call with no function')
          continue
        }
        if (typeof fn.arguments !== 'string') {
          const serialized = JSON.stringify(fn.arguments ?? {})
          repairs.push('re-serialized tool-call arguments to a JSON string')
          calls.push({ ...call, function: { ...fn, arguments: serialized } })
          continue
        }
        calls.push(call)
      }
      if (calls.length === 0) {
        delete repaired.tool_calls
      } else {
        repaired.tool_calls = calls
      }
    }

    messages.push(repaired)
  }

  const changed = repairs.length > 0
  return { body: changed ? { ...body, messages } : body, repairs }
}

/** Model capabilities the effort guard needs to judge a `reasoning_effort`. */
export interface EffortGuardModel {
  id: string
  reasoning?: { supports?: boolean, supportedEfforts?: string[], canDisableThinking?: boolean }
}

/**
 * Drop a `reasoning_effort` the target model does not declare.
 *
 * The gateway validates the value per model and refuses the whole request with
 * `10005` when it is not one of them. Upstream's vocabulary is `none` / `high`
 * / `max`; a literal `off` is never valid, and `none` is only offered by a
 * model that can switch thinking off. Omitting the field lets the model answer
 * at its own default instead of failing.
 */
export function dropUnsupportedEffort(
  body: unknown,
  models: readonly EffortGuardModel[],
): { body: unknown, dropped?: string } {
  if (!isRecord(body)) return { body }
  const effort = body.reasoning_effort
  if (effort === undefined || effort === null) return { body }
  if (typeof effort !== 'string') return { body, dropped: `reasoning_effort=${JSON.stringify(effort)} is not a string` }

  const model = models.find(entry => entry.id === body.model)
  // An id the catalog has not seen yet (a model added upstream after the last
  // refresh) is not evidence that the model has no reasoning, so leave it be.
  if (model === undefined) return { body }
  if (model.reasoning?.supports !== true) {
    return { body: stripEffort(body), dropped: `${String(body.model)} does not accept reasoning_effort` }
  }

  const allowed = new Set(model.reasoning.supportedEfforts ?? [])
  if (model.reasoning.canDisableThinking === true) allowed.add('none')

  // `off` is not upstream's word for it; `none` is. Rename rather than drop so
  // the level the user picked still applies.
  if (effort === 'off') {
    if (model.reasoning.canDisableThinking === true) {
      return { body: { ...body, reasoning_effort: 'none' }, dropped: `reasoning_effort "off" is spelled "none" upstream` }
    }
    return { body: stripEffort(body), dropped: `${String(body.model)} cannot switch thinking off` }
  }

  // No declared levels means the catalog did not learn them; guessing here
  // would break a working request.
  if (allowed.size === 0 || allowed.has(effort)) return { body }
  return { body: stripEffort(body), dropped: `${String(body.model)} does not offer reasoning_effort "${effort}"` }
}

function stripEffort(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body }
  delete next.reasoning_effort
  return next
}

/** Human-readable description of what a fallback shape removes. */
function describeShape(shape: GatewayShape): string {
  return shape === 'optional-fields'
    ? `without ${GATEWAY_OPTIONAL_FIELDS.join('/')} and with system instead of developer`
    : 'with text-only content flattened to strings'
}

/**
 * Compact, content-free summary of the request that was refused.
 *
 * Appended to a 400 the gateway will not explain, so the reader can tell a
 * field-shape problem from a value problem (`max_tokens` far above the model's
 * ceiling, a model id the account does not hold) without turning on debug
 * logging. Deliberately reports structure only — never prompt text.
 */
export function describeRequest(body: unknown): string {
  if (!isRecord(body)) return 'not an object'
  const messages = Array.isArray(body.messages) ? body.messages : []
  const roles = messages
    .map(message => (isRecord(message) && typeof message.role === 'string' ? message.role : '?'))
    .join('>')
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  const effort = body.reasoning_effort === undefined ? undefined : String(body.reasoning_effort)
  return [
    `model=${String(body.model)}`,
    `max_tokens=${maxTokens === undefined ? 'unset' : String(maxTokens)}`,
    `messages=${messages.length} (${roles.slice(0, 80)})`,
    `tools=${tools}`,
    ...(effort === undefined ? [] : [`reasoning_effort=${effort}`]),
    `fields=${Object.keys(body).sort().join('/')}`,
  ].join(', ')
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

  /**
   * Request shape the gateway last accepted.
   *
   * Starts at what pi-ai emits and only narrows after a 400, then stays put
   * for the rest of the process: the first rejected request costs one extra
   * round trip, every later one goes straight to the accepted shape.
   */
  let learnedShape: GatewayShape = 'as-is'

  /** How many failed requests have been dumped this process, for file names. */
  let dumpCount = 0

  /** True once the gateway has been interrogated; the answer does not change. */
  let diagnosisDone = false

  /** Fix learned from a diagnosis, applied to every later request. */
  let learnedFix: ((body: unknown) => unknown) | undefined

  /**
   * Write a refused request to disk so its exact shape can be inspected.
   *
   * The gateway names no field, and its validation is stricter than the
   * documented subset in ways that only the real body reveals. The dump is
   * the only way to see what was actually sent, so it is written for failed
   * requests only, into the OS temp directory, and capped in size. Set
   * `ASTUDIO_DUMP_FAILED=0` to switch it off.
   */
  async function dumpFailedRequest(payload: unknown): Promise<string | undefined> {
    if (process.env.ASTUDIO_DUMP_FAILED === '0') return undefined
    const dir = process.env.ASTUDIO_DUMP_FAILED_DIR ?? join(tmpdir(), 'dsh-astudio-connect', 'failed-requests')
    try {
      await mkdir(dir, { recursive: true })
      dumpCount += 1
      const file = join(dir, `failed-${Date.now()}-${process.pid}-${dumpCount}.json`)
      const text = JSON.stringify(payload, null, 2)
      if (text.length > 16 * 1024 * 1024) return undefined
      await writeFile(file, text, 'utf8')
      // Keep the directory bounded: five bodies is more than enough to compare.
      const entries = (await readdir(dir)).filter(name => name.startsWith('failed-')).sort()
      for (const stale of entries.slice(0, Math.max(0, entries.length - 5))) {
        await unlink(join(dir, stale)).catch(() => undefined)
      }
      return file
    } catch {
      return undefined
    }
  }

  /** One attempt's outcome, plus the body that produced it. */
  interface ChatAttempt {
    result: AStudioUpstreamResult
    body: unknown
    trail: Array<{ shape: GatewayShape, status: number }>
    /** Present when every shape was refused and the gateway was interrogated. */
    diagnosis?: Diagnosis
  }

  /**
   * Send one chat request, narrowing its shape while the gateway answers 400.
   *
   * maas-api refuses a body it does not model with a single opaque
   * `10005 invalid request` that names no field, so the accepted shape can
   * only be found by asking again with less. A non-400 answer ends the search:
   * that is a real upstream failure (auth, rate, server) and retrying it in
   * another shape would only hide it.
   */
  async function chatWithFallback(
    credential: string,
    body: unknown,
    controller: AbortController,
  ): Promise<ChatAttempt> {
    const repaired = repairChatBody(body)
    if (repaired.repairs.length > 0) {
      logger?.warn(`dsh-astudio-connect: repaired ${repaired.repairs.join('; ')}`)
    }

    const guarded = dropUnsupportedEffort(repaired.body, catalog.current())
    if (guarded.dropped !== undefined) {
      logger?.warn(`dsh-astudio-connect: dropped reasoning_effort — ${guarded.dropped}`)
    }

    const prepared = learnedFix === undefined ? guarded.body : learnedFix(guarded.body)
    const attempt = await attemptShapes(credential, prepared, controller)

    // Everything the wire format allows has been tried. Ask the gateway, one
    // dimension at a time, which part of the body it refuses — once per
    // process, because the answer is a property of the account's gateway and
    // not of this request.
    if (attempt.result.ok || attempt.result.status !== 400 || controller.signal.aborted || diagnosisDone) {
      return attempt
    }

    diagnosisDone = true
    const diagnosis = await diagnoseRefusal(prepared, candidate => probeUpstream(credential, candidate, controller))
    if (diagnosis.repair === undefined) {
      logger?.warn(`dsh-astudio-connect: gateway refuses this request — ${diagnosis.summary}`)
      return { ...attempt, diagnosis }
    }

    logger?.warn(`dsh-astudio-connect: gateway refuses this request — ${diagnosis.summary}; retrying without it`)
    learnedFix = fixFor(diagnosis)
    const retried = await attemptShapes(credential, diagnosis.repair, controller)
    if (retried.result.ok) {
      logger?.warn(`dsh-astudio-connect: accepted after applying the fix; it stays applied for this process`)
    }
    return { ...retried, diagnosis, body: retried.result.ok ? retried.body : attempt.body }
  }

  /** Try each request shape in turn, narrowing only while the gateway says 400. */
  async function attemptShapes(
    credential: string,
    body: unknown,
    controller: AbortController,
  ): Promise<ChatAttempt> {
    const trail: Array<{ shape: GatewayShape, status: number }> = []
    let last: AStudioUpstreamResult | undefined
    let lastBody: unknown = body

    for (const shape of [learnedShape, ...GATEWAY_SHAPE_FALLBACKS.filter(candidate => candidate !== learnedShape)]) {
      const attemptBody = sanitizeGatewayBody(body, shape)
      const result = await upstream.chat(credential, attemptBody, controller.signal)
      trail.push({ shape, status: result.status })
      last = result
      lastBody = attemptBody

      if (result.ok) {
        if (shape !== learnedShape) {
          learnedShape = shape
          logger?.warn(
            `dsh-astudio-connect: maas-api refused the request as sent; `
            + `it accepts it ${describeShape(shape)} — using that shape from now on`,
          )
        }
        return { result, body: attemptBody, trail }
      }
      if (result.status !== 400 || controller.signal.aborted) break
    }

    return { result: last as AStudioUpstreamResult, body: lastBody, trail }
  }

  /**
   * One diagnostic request: send it, then drop the response stream at once.
   *
   * A probe only needs the status line. Cancelling the body keeps a passing
   * probe from generating — and billing — a full answer.
   */
  async function probeUpstream(
    credential: string,
    body: unknown,
    controller: AbortController,
  ): Promise<{ ok: boolean, status: number }> {
    const result = await upstream.chat(credential, body, controller.signal)
    await result.response.body?.cancel().catch(() => undefined)
    return { ok: result.ok, status: result.status }
  }

  /** Turn a diagnosed cause into the fix applied to every later request. */
  function fixFor(diagnosis: Diagnosis): ((body: unknown) => unknown) | undefined {
    if (diagnosis.cause === 'max_tokens') {
      return candidate => {
        if (!isRecord(candidate)) return candidate
        const field = candidate.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens'
        const value = candidate[field]
        return typeof value === 'number' && value > SAFE_MAX_TOKENS
          ? { ...candidate, [field]: SAFE_MAX_TOKENS }
          : candidate
      }
    }
    if (diagnosis.cause === 'tools' && diagnosis.offendingTools !== undefined) {
      const refused = new Set(diagnosis.offendingTools)
      return candidate => {
        if (!isRecord(candidate) || !Array.isArray(candidate.tools)) return candidate
        return {
          ...candidate,
          tools: candidate.tools.filter((tool, index) => !refused.has(toolNameOf(tool, index))),
        }
      }
    }
    if (diagnosis.cause === 'reasoning_effort') {
      return candidate => {
        if (!isRecord(candidate)) return candidate
        const next = { ...candidate }
        delete next.reasoning_effort
        return next
      }
    }
    return undefined
  }

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

  // Bind an ephemeral port fetch will actually connect to: the OS can hand out
  // one of the fetch standard's blocked ports, and every pi-ai call would then
  // fail with `TypeError: fetch failed` against a listener that is otherwise up.
  const ready: Promise<void> = bindToUsablePort(server, {
    host: '127.0.0.1',
    onBlockedPort: (port, attempt) => {
      logger?.warn(`dsh-astudio-connect: port ${port} is blocked for fetch; rebinding (attempt ${attempt})`)
    },
  }).then(() => undefined)

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
        const hidden = catalog.hiddenModelIds()
        const models = catalog.current()
          .filter(m => !hidden.includes(m.id))
          .map((m: AStudioModelInfo) => ({
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

    const result = await chatWithFallback(credential, body, controller)

    if (!result.result.ok) {
      const detail = result.result.message.slice(0, 400)
      const kind = result.result.kind as UpstreamErrorKind
      // A 400 means the gateway looked at the request and refused it; every
      // narrower shape was refused too, so say what was sent. Its own body
      // names no field, and this is the only place that knows the request.
      let sent = ''
      if (kind === 'client') {
        const shapes = result.trail.map(entry => `${entry.shape}=${entry.status}`).join(', ')
        sent = ` (request: ${describeRequest(result.body)}; tried ${shapes}`
        if (result.diagnosis !== undefined) sent += `; diagnosis: ${result.diagnosis.summary}`
        const dump = await dumpFailedRequest({ trail: result.trail, body: result.body })
        sent += dump === undefined ? ')' : `; body written to ${dump})`
      }
      writeOpenAIError(res, KIND_STATUS[kind], kind, `astudio upstream ${kind}: ${detail}${sent}`)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const bodyStream = Readable.fromWeb(result.result.response.body as Parameters<typeof Readable.fromWeb>[0])
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
