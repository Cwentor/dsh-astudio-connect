/**
 * Self-diagnosis for a request the gateway refuses without naming a field.
 *
 * maas-api answers a body it does not model with `10005 invalid request` and
 * nothing else, so the only way to learn why is to ask again with one
 * dimension removed at a time. Everything here works on a probe callback, so
 * the search can be unit-tested without a network and the caller decides how
 * a probe is sent.
 *
 * The searches are bounded: one request per dimension, then a bisection of the
 * offending array, which is logarithmic in its length (134 tools cost seven
 * requests, not 134).
 *
 * @module dsh-astudio-connect/diagnose
 */

/** Outcome of one probe request. */
export interface ProbeOutcome {
  ok: boolean
  status: number
}

/** Sends one candidate body and reports whether the gateway accepted it. */
export type DiagnoseProbe = (body: unknown) => Promise<ProbeOutcome>

/** Which part of the request the gateway refuses. */
export type DiagnosisCause = 'max_tokens' | 'tools' | 'messages' | 'reasoning_effort' | 'unknown'

/** What the diagnosis concluded. */
export interface Diagnosis {
  cause: DiagnosisCause
  /** One line for the log and the error message. */
  summary: string
  /** Names of the tool definitions that were refused, when `cause` is 'tools'. */
  offendingTools?: string[]
  /** A body with the offending part removed, ready to send again. */
  repair?: Record<string, unknown>
  /** How many probe requests it took. */
  requests: number
}

/** Output budget a probe asks for, so a probe never generates a long answer. */
const PROBE_MAX_TOKENS = 16

/** Ceiling the `max_tokens` repair clamps to. */
export const SAFE_MAX_TOKENS = 8192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withFields(body: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...body, ...patch }
}

/**
 * Index of an item whose presence makes the array get refused.
 *
 * Returns -1 when neither half is at fault, which happens when the failure is
 * not caused by an individual element. Bisection assumes monotonicity — a
 * subset containing the bad item fails, one without it passes — which holds
 * for validation of independent array entries.
 */
async function offendingIndex<T>(
  items: readonly T[],
  probe: (subset: readonly T[]) => Promise<boolean>,
): Promise<number> {
  if (items.length <= 1) return items.length === 1 && (await probe(items)) ? 0 : -1
  const mid = Math.floor(items.length / 2)
  const left = items.slice(0, mid)
  if (await probe(left)) return offendingIndex(left, probe)
  const right = items.slice(mid)
  const offset = await offendingIndex(right, probe)
  return offset === -1 ? -1 : mid + offset
}

/** Name a tool entry for the report, without trusting its shape. */
export function toolNameOf(entry: unknown, index: number): string {
  if (isRecord(entry) && isRecord(entry.function) && typeof entry.function.name === 'string') {
    return entry.function.name
  }
  if (isRecord(entry) && typeof entry.name === 'string') return entry.name
  return `#${index}`
}

/** Describe a message by role and content kinds, never by its text. */
function describeMessage(message: unknown): string {
  if (!isRecord(message)) return 'is not an object'
  const role = typeof message.role === 'string' ? message.role : 'unknown-role'
  const content = message.content
  if (Array.isArray(content)) {
    const kinds = [...new Set(content.map(part => (isRecord(part) && typeof part.type === 'string' ? part.type : '?')))]
    return `(${role}, parts: ${kinds.join('/')})`
  }
  return `(${role}, ${typeof content === 'string' ? 'text' : typeof content})`
}

/**
 * Find which tool definitions the gateway refuses, by bisection.
 *
 * Bounded to a few offenders: one broken definition is the common case, and a
 * long tail of them is better reported than repaired.
 */
export async function findOffendingTools(
  body: Record<string, unknown>,
  probe: DiagnoseProbe,
): Promise<{ names: string[], indexes: number[] }> {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names: string[] = []
  const indexes: number[] = []
  let remaining = [...tools.map((tool, index) => ({ tool, index }))]

  for (let round = 0; round < 3 && remaining.length > 0; round += 1) {
    const found = await offendingIndex(remaining, async subset => {
      const outcome = await probe(withFields(body, {
        max_tokens: PROBE_MAX_TOKENS,
        tools: subset.map(entry => entry.tool),
      }))
      return !outcome.ok
    })
    if (found === -1) break
    const offender = remaining[found]
    if (offender === undefined) break
    names.push(toolNameOf(offender.tool, offender.index))
    indexes.push(offender.index)
    remaining = remaining.filter((_, position) => position !== found)
  }

  return { names, indexes }
}

/**
 * Work out why a body is refused, and where possible hand back a fixed body.
 *
 * The dimensions are tried cheapest-first: one field value, then the whole
 * tool list, then the message history. Each probe keeps the rest of the body
 * intact, including every field whose presence has already been accepted, so
 * a passing probe isolates exactly one difference.
 */
export async function diagnoseRefusal(body: unknown, probe: DiagnoseProbe): Promise<Diagnosis> {
  if (!isRecord(body)) {
    return { cause: 'unknown', summary: 'the request body is not an object', requests: 0 }
  }

  let requests = 0
  const ask = async (candidate: Record<string, unknown>): Promise<boolean> => {
    requests += 1
    const outcome = await probe(candidate)
    return outcome.ok
  }

  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  const budgetField = body.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens'

  // 1. Output budget. A model asked for more than it can emit refuses the
  //    whole request, and the value is one field, so test it first.
  if (typeof maxTokens === 'number' && maxTokens > SAFE_MAX_TOKENS) {
    if (await ask(withFields(body, { [budgetField]: PROBE_MAX_TOKENS }))) {
      const clamped = Math.min(maxTokens, SAFE_MAX_TOKENS)
      return {
        cause: 'max_tokens',
        summary: `${budgetField}=${maxTokens} is above what the model accepts; ${clamped} works`,
        repair: withFields(body, { [budgetField]: clamped }),
        requests,
      }
    }
  }

  // 2. Tool definitions. One malformed entry — a missing `type`, a
  //    non-object — fails every request that carries it.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    if (await ask(withFields(body, { max_tokens: PROBE_MAX_TOKENS, tools: [] }))) {
      const { names, indexes } = await findOffendingTools(body, probe)
      if (indexes.length > 0) {
        const kept = (body.tools as unknown[]).filter((_, index) => !indexes.includes(index))
        return {
          cause: 'tools',
          summary: `tool ${names.map(name => `"${name}"`).join(', ')} ${names.length === 1 ? 'is' : 'are'} refused by the gateway`,
          offendingTools: names,
          repair: withFields(body, { tools: kept }),
          requests,
        }
      }
      return {
        cause: 'tools',
        summary: `the request is accepted without tools, but no single definition is at fault (${(body.tools as unknown[]).length} sent)`,
        requests,
      }
    }
  }

  // 3. Reasoning effort. The gateway validates the level against the model's
  //    own list and refuses the request outright for a level it does not offer.
  if (body.reasoning_effort !== undefined) {
    const without: Record<string, unknown> = { ...body, max_tokens: PROBE_MAX_TOKENS }
    delete without.reasoning_effort
    if (await ask(without)) {
      const stripped = { ...body }
      delete stripped.reasoning_effort
      return {
        cause: 'reasoning_effort',
        summary: `reasoning_effort=${String(body.reasoning_effort)} is not accepted for ${String(body.model)}`,
        repair: stripped,
        requests,
      }
    }
  }

  // 4. Message history. A bad content part (an Anthropic-style block, a null
  //    payload) fails the whole request; a prefix search finds which message
  //    introduces it, since a prefix without that message is accepted.
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.length > 2) {
    const fails = async (prefixLength: number): Promise<boolean> => {
      const outcome = await probe(withFields(body, {
        max_tokens: PROBE_MAX_TOKENS,
        messages: messages.slice(0, prefixLength),
      }))
      requests += 1
      return !outcome.ok
    }
    // A prefix without the offending message is accepted, so the failure is
    // monotone in the prefix length. Two messages is the shortest prefix that
    // is still a conversation; if even that is refused, something outside the
    // later history is to blame and this search cannot localise it.
    if (!(await fails(2))) {
      let low = 2
      let high = messages.length
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2)
        if (await fails(mid)) high = mid
        else low = mid
      }
      const index = high - 1
      return {
        cause: 'messages',
        summary: `message #${index} ${describeMessage(messages[index])} is refused; everything before it is accepted`,
        requests,
      }
    }
  }

  return {
    cause: 'unknown',
    summary: `no single field explains it (${messages.length} messages, ${Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0} tools, ${budgetField}=${String(maxTokens)})`,
    requests,
  }
}
