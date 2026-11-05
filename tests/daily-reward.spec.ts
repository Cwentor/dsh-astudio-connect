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
  ASTRO_TENANT_INIT_PATH,
  ASTRO_CLIENT_VERSION,
  ASTRO_STUDIO_VERSION,
} from '../src/daily-reward.ts'
import type { AStudioDailyRewardCredentials } from '../src/daily-reward.ts'
import type { AStudioPointsClient } from '../src/points.ts'
import type { AStudioWebPoints } from '../src/status-paths.ts'

/**
 * The daily-reward claim.
 *
 * Measured against the live service on 2026-11-05: the credit lands during
 * `tenant-app/v2/init-app`, the call the desktop app makes at launch, and
 * `client-popups/complete` only dismisses the dialog that announces it. These
 * tests pin that order — without the initialisation nothing is ever issued,
 * which is why an earlier version reported "nothing to claim" on every day the
 * app had been closed.
 *
 * They also pin the rule that an amount is only ever the balance difference
 * this press produced: current clients send no figure in the popup payload, so
 * a test that fed one would be testing a shape the service no longer uses.
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

/** A readable balance carrying one general amount. */
function balanceWith(remaining: number): AStudioWebPoints {
  return {
    status: 'ok',
    general: { remaining, total: 2500 },
    spark: { remaining: 24621, total: 30000 },
  }
}

/** The balance the service answers with when it cannot be read. */
const UNREADABLE: AStudioWebPoints = { status: 'unavailable' }

/** The pre-claim and post-claim balances of a reward worth 100. */
const BEFORE = balanceWith(1493)
const AFTER = balanceWith(1593)

/**
 * A points client stand-in that records how it was asked and answers from a
 * sequence: the first read is the "before" balance, the second the "after".
 */
function stubPoints(balances: AStudioWebPoints[] = [BEFORE, AFTER]): {
  client: AStudioPointsClient
  reads: Array<{ fresh?: boolean }>
} {
  const reads: Array<{ fresh?: boolean }> = []
  return {
    reads,
    client: {
      async read(options = {}) {
        const answer = balances[Math.min(reads.length, balances.length - 1)] ?? UNREADABLE
        reads.push(options)
        return answer
      },
    },
  }
}

/** One answer from the account gateway. */
function envelope(data: unknown, code = 0): Record<string, unknown> {
  return { flag: code === 0, code, desc: code === 0 ? '成功' : 'failed', data }
}

/**
 * The daily dialog as the live gateway shapes it on 2026-11-05.
 *
 * `payload` carries the wording and no amount at all — the figure only exists
 * as the balance difference the initialisation produced.
 */
function pendingList(): Record<string, unknown>[] {
  return [
    {
      popupId: 2,
      popupCode: 'DAILY_LOGIN_REWARD_V1',
      popupType: 'BANNER',
      componentType: 'DAILY_REWARD_DIALOG',
      priority: 100,
      instanceKey: '20261105',
      payload: {
        title: '今日登录积分已到账',
        content: '每日登录积分已发放，可前往积分中心查看。',
        confirmText: '知道了',
      },
    },
  ]
}

/** Record every call, answering from a route table keyed by the last segment. */
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

/** Every route a happy-path claim needs. */
function happyRoutes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    'init-app': () => new Response(JSON.stringify(envelope({ banned: false }))),
    pending: () => new Response(JSON.stringify(envelope(pendingList()))),
    complete: () => new Response(JSON.stringify(envelope(null))),
    ...overrides,
  }
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
  it('initialises the tenant, closes the dialog and reports the credit that landed', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl, calls } = recordingFetch(happyRoutes())

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'claimed', points: 100, balance: AFTER })
    // The order is the whole fix: the initialisation is what makes the service
    // settle the day, so it has to come before the list is read.
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      `/xingchen-studio/${ASTRO_TENANT_INIT_PATH}`,
      `/xingchen-studio/${ASTRO_DAILY_REWARD_PENDING_PATH}`,
      `/xingchen-studio/${ASTRO_DAILY_REWARD_COMPLETE_PATH}`,
    ])
    assertCall(calls[0]!, 'tenant-app/v2/init-app')
    expect(calls[0]!.init?.method).toBe('POST')
    assertCall(calls[1]!, 'client-popups/pending')
    assertCall(calls[2]!, 'client-popups/complete')
    expect(calls[2]!.init?.method).toBe('POST')
    // Both values are echoed exactly as the pending list gave them: no
    // signature, no locally invented key.
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ popupId: 2, instanceKey: '20261105' })
    // Before and after are both fresh reads: the difference is the amount.
    expect(points.reads).toEqual([{ fresh: true }, { fresh: true }])
  })

  it('reports claimed even when the dialog itself will not close, because the credit landed', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch(happyRoutes({
      complete: () => new Response(JSON.stringify(envelope(null, 50000))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // The balance moved by 100, so the press did earn it. Refusing to say so
    // because a banner stayed open would report a failure that did not happen.
    expect(result).toEqual({ status: 'claimed', points: 100, balance: AFTER })
  })

  it('reports none when the initialisation issues nothing and no dialog is waiting', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl } = recordingFetch(happyRoutes({
      pending: () => new Response(JSON.stringify(envelope([]))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // An expired plan and an already-collected day both look like this; the
    // section's wording has to allow for both rather than assert a claim.
    expect(result).toEqual({ status: 'none' })
  })

  it('reports already when a dialog is closed but the balance does not move', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl } = recordingFetch(happyRoutes())

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // The credit was on the account before the press — typically a client that
    // received the banner and was closed before dismissing it.
    expect(result).toEqual({ status: 'already' })
  })

  it('reports unavailable, not already, when the initialisation failed and nothing moved', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl } = recordingFetch(happyRoutes({
      'init-app': () => new Response(JSON.stringify(envelope(null, 50000))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // A failed settlement leaves the day unsettled, so "already claimed" would
    // be a guess dressed up as a fact.
    expect(result).toEqual({ status: 'unavailable' })
  })

  it('ignores non-daily popups entirely', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl, calls } = recordingFetch({
      'init-app': () => new Response(JSON.stringify(envelope({ banned: false }))),
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: 91235, componentType: 'ANNOUNCEMENT_BANNER', instanceKey: 'k', payload: {} },
        { popupId: 91236, componentType: 'NEW_USER_DIALOG', instanceKey: 'k2', payload: {} },
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
    expect(calls.map(call => new URL(call.url).pathname.split('/').pop())).toEqual(['init-app', 'pending'])
  })

  it('reports claimed without an amount when neither balance can be read', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([UNREADABLE, UNREADABLE])
    const { fetchImpl } = recordingFetch(happyRoutes())

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // A closed dialog after a successful initialisation is the client's own
    // success path; an unreadable balance must not turn it into a failure.
    expect(result).toEqual({ status: 'claimed', balance: UNREADABLE })
  })

  it('reports unavailable when the dialog list itself cannot be read', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl } = recordingFetch(happyRoutes({
      pending: () => new Response(JSON.stringify(envelope(null, 50000))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // "Nothing pending" cannot be concluded from a list that never arrived.
    expect(result).toEqual({ status: 'unavailable' })
  })

  it('reports signed-out without reading anything when there is no ssoSessionId', async () => {
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
    expect(points.reads).toEqual([])
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
    expect(points.reads).toEqual([])
  })

  it('maps a dead session to expired, from the body and from the HTTP status', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()

    const byCode = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl: recordingFetch({ 'init-app': () => new Response(JSON.stringify(envelope(null, 80000))) }).fetchImpl,
      clientType: '21',
    }).claim()
    expect(byCode).toEqual({ status: 'expired' })

    const byStatus = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl: recordingFetch({ 'init-app': () => new Response('', { status: 401 }) }).fetchImpl,
      clientType: '21',
    }).claim()
    expect(byStatus).toEqual({ status: 'expired' })
  })

  it('reports expired when the balance read says the session is dead', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([{ status: 'expired' }])
    const { fetchImpl, calls } = recordingFetch({})

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // Nothing is sent to a session already known to be dead.
    expect(result).toEqual({ status: 'expired' })
    expect(calls).toEqual([])
  })

  it('reports unavailable when the gateway cannot be reached', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
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
    const { fetchImpl, calls } = recordingFetch(happyRoutes({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: '91234', componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-1' },
      ]))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    expect(result).toEqual({ status: 'claimed', points: 100, balance: AFTER })
    // `client-popups/complete` is parsed with Number.isSafeInteger upstream, so
    // the id has to travel as a number even when it arrived quoted.
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ popupId: 91234, instanceKey: 'instance-1' })
  })

  it('ignores ids the completion endpoint would reject, such as a dev preview', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints([BEFORE, BEFORE])
    const { fetchImpl, calls } = recordingFetch(happyRoutes({
      pending: () => new Response(JSON.stringify(envelope([
        { popupId: -3, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'DEV_PREVIEW' },
        { popupId: 0, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-0' },
        { popupId: 'not-a-number', componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-x' },
        { componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'instance-y' },
      ]))),
    }))

    const result = await createAStudioDailyRewardClient({
      credentials: () => claimCredentialsAt(sessionPath),
      points: points.client,
      fetchImpl,
      clientType: '21',
    }).claim()

    // Posting a popup the endpoint cannot parse would fail the whole claim, so
    // an unusable id is skipped and the press ends as "nothing issued".
    expect(result).toEqual({ status: 'none' })
    expect(calls.map(call => new URL(call.url).pathname.split('/').pop())).toEqual(['init-app', 'pending'])
  })

  it('never carries the session cookie into its answer', async () => {
    const sessionPath = await sessionFile(SIGNED_IN)
    const points = stubPoints()
    const { fetchImpl } = recordingFetch(happyRoutes())

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
