/**
 * AStudio maas-api upstream client. Sends standard OpenAI chat/completions
 * requests to maas-api and returns a structured result. No protocol
 * transformation — maas-api speaks standard OpenAI.
 *
 * @module dsh-astudio-connect/upstream
 */

/** Classification of an upstream failure. */
export type UpstreamErrorKind = 'auth' | 'not_found' | 'rate' | 'server' | 'client'

/** Result of an upstream request. */
export interface AStudioUpstreamResult {
  /** True when the upstream returned 2xx. */
  ok: boolean
  /** HTTP status code. */
  status: number
  /** Error classification, or 'ok' on success. */
  kind: UpstreamErrorKind | 'ok'
  /** Human-readable error message. */
  message: string
  /** Raw fetch Response — caller reads .text() (non-stream) or pipes .body (stream). */
  response: Response
}

/** Default maas-api endpoint. */
export const DEFAULT_UPSTREAM_URL = 'https://maas-api.cn-huabei-1.xf-yun.com/v1'

/** HTTP status each error class maps to. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  auth: 401,
  not_found: 502,
  rate: 429,
  server: 502,
  client: 400,
}

/** Classify an HTTP status into an error kind. */
function classifyStatus(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return 'client'
}

/** Options for the upstream client. */
export interface AStudioUpstreamOptions {
  /** Override the base URL (used by tests). */
  baseUrl?: string
}

/**
 * Send a chat completion request to maas-api.
 *
 * Returns a structured result regardless of HTTP status. On 2xx, `ok` is
 * true and `kind` is 'ok'. On failure, `kind` classifies the error and
 * `message` carries a short summary extracted from the response body.
 */
export function createAStudioUpstream(options: AStudioUpstreamOptions = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_UPSTREAM_URL

  /** Send a chat completion request. Returns the full result including the raw Response. */
  async function chat(
    token: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<AStudioUpstreamResult> {
    const url = `${baseUrl}/chat/completions`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // Network-level failure — synthesize a server error with a null response.
      return { ok: false, status: 0, kind: 'server', message, response: null as unknown as Response }
    }

    if (res.ok) {
      return { ok: true, status: res.status, kind: 'ok', message: '', response: res }
    }

    const kind = classifyStatus(res.status)
    const text = await res.text().catch(() => '')
    const message = text.slice(0, 400)
    return { ok: false, status: res.status, kind, message, response: res }
  }

  return { chat }
}
