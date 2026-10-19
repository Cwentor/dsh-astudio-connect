import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAStudioPointsClient,
  parseAStudioPointsBalance,
  readSsoSessionId,
  ASTRO_POINTS_BALANCE_URL,
  ASTRO_POINTS_CACHE_MS,
} from '../src/points.ts'

/**
 * The points balance read: AStudio's own account endpoint, reached with the
 * `ssoSessionId` the desktop app already stores. Every failure is a named
 * state, never a zero — a fabricated balance is worse than an absent one.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A session file in a throwaway data root, in AStudio's own layout. */
async function sessionFile(content: unknown | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astudio-points-'))
  CLEANUP.push(async () => { await rm(root, { recursive: true, force: true }) })
  const userdata = join(root, 'userdata')
  await mkdir(userdata, { recursive: true })
  const path = join(userdata, 'astron-session.json')
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

/** The real upstream answer, trimmed to the fields the badge reads. */
function balanceResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flag: true,
    code: 0,
    desc: '成功',
    data: {
      totalAmount: 2500,
      totalBalance: 1393,
      memberTotal: 0,
      memberBalance: 0,
      buyTotal: 0,
      buyBalance: 0,
      activityTotal: 2500,
      activityBalance: 1393,
      sparkTotalAmount: 30000,
      sparkTotalBalance: 24621,
      ...overrides,
    },
  }
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('reading the account session', () => {
  it('returns the ssoSessionId AStudio stores', async () => {
    const path = await sessionFile({ accountId: '21904980315', ssoSessionId: 'sso-abc', token: 't', modelBearerToken: 'm' })
    expect(readSsoSessionId(path)).toBe('sso-abc')
  })

  it('returns undefined for a missing file', () => {
    expect(readSsoSessionId(join(tmpdir(), 'astudio-nonexistent-session.json'))).toBeUndefined()
  })

  it('returns undefined for malformed JSON', async () => {
    const path = await sessionFile('{ not json')
    expect(readSsoSessionId(path)).toBeUndefined()
  })

  it('returns undefined when the field is absent or blank', async () => {
    expect(readSsoSessionId(await sessionFile({ accountId: 'x' }))).toBeUndefined()
    expect(readSsoSessionId(await sessionFile({ ssoSessionId: '   ' }))).toBeUndefined()
  })
})

describe('parsing the balance answer', () => {
  it('reads both pools from the upstream envelope', () => {
    expect(parseAStudioPointsBalance(balanceResponse())).toEqual({
      status: 'ok',
      general: { remaining: 1393, total: 2500 },
      spark: { remaining: 24621, total: 30000 },
    })
  })

  it('keeps a zero balance as a real number', () => {
    const parsed = parseAStudioPointsBalance(balanceResponse({ totalBalance: 0, sparkTotalBalance: 0 }))
    expect(parsed).toEqual({
      status: 'ok',
      general: { remaining: 0, total: 2500 },
      spark: { remaining: 0, total: 30000 },
    })
  })

  it('omits the spark pool when the optional field is absent', () => {
    const body = balanceResponse()
    delete (body['data'] as Record<string, unknown>)['sparkTotalBalance']
    delete (body['data'] as Record<string, unknown>)['sparkTotalAmount']
    expect(parseAStudioPointsBalance(body)).toEqual({
      status: 'ok',
      general: { remaining: 1393, total: 2500 },
    })
  })

  it('reports a signed-out answer as expired rather than a balance', () => {
    // Measured: the upstream answers 200 with this body for a dead session.
    expect(parseAStudioPointsBalance({ code: 80000, flag: false, desc: '登录异常，请重新登录' }))
      .toEqual({ status: 'expired' })
  })

  it('reports an unrecognised envelope as unavailable, never as zero', () => {
    expect(parseAStudioPointsBalance({ hello: 'world' })).toEqual({ status: 'unavailable' })
    expect(parseAStudioPointsBalance('nonsense')).toEqual({ status: 'unavailable' })
    expect(parseAStudioPointsBalance({ flag: true, code: 0, data: { totalBalance: 'lots' } }))
      .toEqual({ status: 'unavailable' })
  })
})

describe('the points client', () => {
  it('sends the ssoSessionId cookie and no other credential', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc', token: 'chat-token', modelBearerToken: 'model-token' })
    let seenHeaders: Headers | undefined
    let seenUrl = ''
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async (input: string, init: RequestInit) => {
        seenUrl = input
        seenHeaders = new Headers(init.headers)
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await client.read()
    expect(seenUrl).toBe(ASTRO_POINTS_BALANCE_URL)
    expect(seenHeaders?.get('cookie')).toBe('ssoSessionId=sso-abc')
    expect(seenHeaders?.get('cookie')).not.toContain('chat-token')
    expect(seenHeaders?.get('cookie')).not.toContain('model-token')
  })

  it('caches a good read inside the TTL window', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc' })
    let calls = 0
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await client.read()
    await client.read()
    expect(calls).toBe(1)
  })

  it('re-reads once the TTL window has passed', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc' })
    let calls = 0
    let now = 1_000_000
    const client = createAStudioPointsClient({
      sessionPath: path,
      now: () => now,
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await client.read()
    now += ASTRO_POINTS_CACHE_MS + 1
    await client.read()
    expect(calls).toBe(2)
  })

  it('bypasses the cache when the caller asks for a fresh read', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc' })
    let calls = 0
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await client.read()
    await client.read({ fresh: true })
    expect(calls).toBe(2)
  })

  it('re-reads the session file so a re-login is picked up', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-old' })
    const cookies: string[] = []
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async (_input: string, init: RequestInit) => {
        cookies.push(new Headers(init.headers).get('cookie') ?? '')
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await client.read({ fresh: true })
    await writeFile(path, JSON.stringify({ ssoSessionId: 'sso-new' }), 'utf8')
    await client.read({ fresh: true })
    expect(cookies[0]).toContain('sso-old')
    expect(cookies[1]).toContain('sso-new')
  })

  it('reports signed-out when there is no ssoSessionId, and calls nothing', async () => {
    const path = await sessionFile({ accountId: 'x' })
    let calls = 0
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => {
        calls += 1
        return new Response('{}')
      }) as unknown as typeof fetch,
    })
    expect(await client.read()).toEqual({ status: 'signed-out' })
    expect(calls).toBe(0)
  })

  it('reports unavailable on a network failure and does not cache it', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc' })
    let calls = 0
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return new Response(JSON.stringify(balanceResponse()), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await client.read()).toEqual({ status: 'unavailable' })
    // The failure must not be cached: the next read tries again and succeeds.
    expect((await client.read()).status).toBe('ok')
    expect(calls).toBe(2)
  })

  it('reports expired on HTTP 401', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-abc' })
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    })
    expect(await client.read()).toEqual({ status: 'expired' })
  })

  it('never leaks the credential into a failure state', async () => {
    const path = await sessionFile({ ssoSessionId: 'sso-secret-value' })
    const client = createAStudioPointsClient({
      sessionPath: path,
      fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch,
    })
    const result = await client.read()
    expect(JSON.stringify(result)).not.toContain('sso-secret-value')
  })
})
