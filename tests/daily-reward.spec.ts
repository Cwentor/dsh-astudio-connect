import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  astudioClientType,
  createAStudioDailyRewardClient,
  ASTRO_DAILY_REWARD_COMPLETE_PATH,
  ASTRO_DAILY_REWARD_PENDING_PATH,
  ASTRO_CLIENT_VERSION,
  ASTRO_STUDIO_VERSION,
} from '../src/daily-reward.ts'
import type { AStudioDailyRewardCredentials } from '../src/daily-reward.ts'
import type { AStudioPointsClient } from '../src/points.ts'
import type { AStudioWebPoints } from '../src/status-paths.ts'

/**
 * The daily-reward claim: AStudio hands the reward out as a popup, and booking
 * it is one `client-popups/complete`. What is pinned here is the parts that
 * break silently if they regress — the two identity headers the gateway
 * refuses without, the popup selection, and the rule that an outcome this
 * module could not book is never reported as a claim.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A session file in a throwaway data root, in AStudio's own layout. */
async function sessionFile(content: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astudio-claim-'))
  CLEANUP.push(async () => { await rm(root, { recursive: true, force: true }) })
  const userdata = join(root, 'userdata')
  await mkdir(userdata, { recursive: true })
  const path = join(userdata, 'astron-session.json')
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

const SIGNED_IN = {
  ssoSessionId: 'sso-value',
  accountId: '21904980315',
  token: 'account-token',
  modelBearerToken: 'model-value',
}

/**
 * The credentials the real store would hand over, read from a throwaway file.
 *
 * Deliberately mirrors `AuthStore.claimCredentials` — the cookie shape is the
 * thing under test here, so faking it inline would test nothing.
 */
function claimCredentialsAt(sessionPath: string): AStudioDailyRewardCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sessionPath, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const ssoSessionId = record['ssoSessionId']
  if (typeof ssoSessionId !== 'string' || ssoSessionId === '') return undefined
  const accountId = record['accountId']
  const token = record['token']
  return {
    ssoSessionId,
    ...(typeof accountId === 'string' ? { accountId } : {}),
    ...(typeof token === 'string' ? { token } : {}),
  }
}

/** Balance document the shared points client answers with after a claim. */
const BALANCE: AStudioWebPoints = {
  status: 'ok',
  general: { remaining: 1493, total: 2500 },
  spark: { remaining: 24621, total: 30000 },
}

/** A points client stand-in that records how it was asked. */
function stubPoints(): { client: AStudioPointsClient, reads: Array<{ fresh?: boolean }> } {
  const reads: Array<{ fresh?: boolean }> = []
  return {
    reads,
    client: {
      async read(options = {}) {
        reads.push(options)
        return BALANCE
      },
    },
  }
}

/** One answer from the account gateway. */
function envelope(data: unknown, code = 0): Record<string, unknown> {
  return { flag: code === 0, code, desc: code === 0 ? '成功' : 'failed', data }
}

/** The popup list as the live gateway shapes it: `popupId` is an integer. */
function pendingList(): Record<string, unknown>[] {
  return [
    {
      popupId: 91234,
      popupCode: 'DAILY_REWARD_2026_11_04',
      popupType: 'BANNER',
      componentType: 'DAILY_REWARD_DIALOG',
      priority: 100,
      instanceKey: 'instance-1',
      payload: { points: '100' },
    },
  ]
}

/** Record every call, answering from a route table. */
function recordingFetch(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string, init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const path = new URL(url).pathname.split('/').pop() ?? ''
    const route = routes[path]
    if (route === undefined) throw new Error(`unexpected call: ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function assertCall(call: { url: string, init: RequestInit | undefined }, path: string): void {
  expect(call.url).toContain(path)
  const headers = call.init?.headers as Record<string, string>
  // The gateway answers 11001001 without both identity headers. `clientVersion`
  // is a third header the desktop app adds to every xfyun request; sending it
  // keeps this request indistinguishable from one made by the app.
  expect(headers['clientType']).toBe('21')
  expect(headers['studioVersion']).toBe(ASTRO_STUDIO_VERSION)
  expect(headers['clientVersion']).toBe(ASTRO_CLIENT_VERSION)
  // The four cookie pairs the desktop client sends. `account_id` and `token`
  // are what make the request account-scoped: without them the popup service
  // answers an empty list, which is indistinguishable from "no reward today".
  expect(headers['Cookie']).toBe(
    'ssoSessionId=sso-value; sso_sessionid=sso-value; account_id=21904980315; token=account-token',
  )
}

describe('astudioClientType', () => {
  it('maps the two platforms AStudio ships on', () => {
    expect(astudioClientType('win32')).toBe('21')
    expect(astudioClientType('darwin')).toBe('22')
  })

  it('reports no identity for a platform AStudio does not ship on', () => {
    expect(astudioClientType('linux')).toBeUndefined()
  })
})

describe('createAStudioDailyRewardClient', () => {
  it('books a pending daily reward and reports the reward plus the new balance', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope(pendingList()))),
      complete: () => new Response(JSON.stringify(envelope(null))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'claimed', points: 100, balance: BALANCE })
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      `/xingchen-studio/${ASTRO_DAILY_REWARD_PENDING_PATH}`,
      `/xingchen-studio/${ASTRO_DAILY_REWARD_COMPLETE_PATH}`,
    ])
    assertCall(calls[0]!, 'client-popups/pending')
    assertCall(calls[1]!, 'client-popups/complete')
    expect(calls[1]!.init?.method).toBe('POST')
    // Both values are echoed exactly as the pending list gave them: no
    // signature, no locally invented key.
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ popupId: 91234, instanceKey: 'instance-1' })
    // The follow-up balance is a fresh read, never the 30-second cache.
    expect(points.reads).toEqual([{ fresh: true }])
  })

  it('reports none and books nothing when the pending list holds no daily reward', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: 91235, componentType: 'ANNOUNCEMENT_BANNER', instanceKey: 'k', payload: {} },
      ]))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'none' })
    // Completing a popup this module did not understand would be acting on the
    // user's behalf without knowing what for.
    expect(calls).toHaveLength(1)
    expect(points.reads).toEqual([])
  })

  it('reports claimed without an amount when the popup carries none', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: 91234, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-1' },
      ]))),
      complete: () => new Response(JSON.stringify(envelope(null))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // An unparsable amount must not render as "+0".
    expect(result).toEqual({ status: 'claimed', balance: BALANCE })
  })

  it('reports already, not claimed, when every popup was booked before this press', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope(pendingList()))),
      complete: () => new Response(JSON.stringify(envelope(null, 11003002))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // A second press cannot mint credit — upstream answers 11003002. That is
    // "the reward is already yours", which is a different sentence from
    // "+100", and a different one again from "nothing to claim".
    expect(result).toEqual({ status: 'already' })
    expect(points.reads).toEqual([])
  })

  it('reports claimed when one popup booked and another was already done', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    let completed = 0
    const { fetchImpl } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: 1, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'a', payload: { points: '100' } },
        { popupId: 2, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'b', payload: { points: '50' } },
      ]))),
      complete: () => {
        completed += 1
        return new Response(JSON.stringify(completed === 1 ? envelope(null) : envelope(null, 11003002)))
      },
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // Only the reward this press actually booked counts toward the amount.
    expect(result).toEqual({ status: 'claimed', points: 100, balance: BALANCE })
  })

  it('reports unavailable when the completion itself fails', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope(pendingList()))),
      complete: () => new Response(JSON.stringify(envelope(null, 50000))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // Nothing was booked, so nothing may be reported as claimed.
    expect(result).toEqual({ status: 'unavailable' })
    expect(points.reads).toEqual([])
  })

  it('reports signed-out without touching the network when there is no ssoSessionId', async () => {
    const sessionPath = await sessionFile({ modelBearerToken: 'model-value' })
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({})

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'signed-out' })
    expect(calls).toEqual([])
  })

  it('reports unavailable instead of guessing an identity on an unsupported platform', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({})

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: undefined,
    }).claim()

    // A guessed clientType would be answered with 11001001 and read as a
    // service failure, which would hide the real cause.
    expect(result).toEqual({ status: 'unavailable' })
    expect(calls).toEqual([])
  })

  it('maps a dead session to expired, from the body and from the HTTP status', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()

    const byCode = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl: recordingFetch({ pending: () => new Response(JSON.stringify(envelope(null, 80000))) }).fetchImpl,
      clientType: '21',
    }).claim()
    expect(byCode).toEqual({ status: 'expired' })

    const byStatus = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl: recordingFetch({ pending: () => new Response('', { status: 401 }) }).fetchImpl,
      clientType: '21',
    }).claim()
    expect(byStatus).toEqual({ status: 'expired' })
  })

  it('reports unavailable when the gateway cannot be reached', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'unavailable' })
  })

  it('accepts a popup id that arrives as digits in a string, and sends it back as a number', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: '91234', componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-1', payload: { points: '100' } },
      ]))),
      complete: () => new Response(JSON.stringify(envelope(null))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'claimed', points: 100, balance: BALANCE })
    // `client-popups/complete` is parsed with Number.isSafeInteger upstream, so
    // the id has to travel as a number even when it arrived quoted.
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ popupId: 91234, instanceKey: 'instance-1' })
  })

  it('ignores ids the completion endpoint would reject, such as a dev preview', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: -3, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'DEV_PREVIEW', payload: { points: '100' } },
        { popupId: 0, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-0', payload: {} },
        { popupId: 'not-a-number', componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-x', payload: {} },
        { componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-y', payload: {} },
      ]))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // Posting a popup the endpoint cannot parse would fail the whole claim, so
    // an unusable id is skipped and the press ends as "nothing pending".
    expect(result).toEqual({ status: 'none' })
    expect(calls).toHaveLength(1)
  })

  it('never carries the session cookie into its answer', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch({
      pending: () => new Response(JSON.stringify(envelope(pendingList()))),
      complete: () => new Response(JSON.stringify(envelope(null))),
    })

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(JSON.stringify(result)).not.toContain('sso-value')
    expect(JSON.stringify(result)).not.toContain('model-value')
  })
})
