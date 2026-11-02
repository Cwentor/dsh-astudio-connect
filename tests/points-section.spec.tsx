import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create, act } from 'react-test-renderer'
import type { ReactTestInstance } from 'react-test-renderer'
import { AStudioPointsSection } from '../src/client/AStudioPointsSection.tsx'
import type { AStudioPointsSectionProps } from '../src/client/AStudioPointsSection.tsx'
import { isClaimDocument, isPointsDocument } from '../src/client/points-client.ts'
import {
  ASTRO_CLAIM_PATH,
  ASTRO_CONTROL_KEY_HEADER,
  ASTRO_POINTS_PATH,
  ASTRO_STATUS_PATH,
} from '../src/status-paths.ts'
import type { AStudioWebPoints } from '../src/status-paths.ts'
import { en } from '../src/client/locales.ts'

/**
 * The Settings section: the two pools, the refresh, and the daily-reward press.
 *
 * These are the assertions the composer badge used to carry, moved with the
 * feature — the panel is a different surface, not a different contract.
 */

/** The locale binder's interpolation, in miniature. */
const t = (key: string, params?: Record<string, unknown>): string => {
  const template = en[key as keyof typeof en] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

/** Build a fetch Response stand-in. */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

/** Flush pending promises inside act. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Render the section and wait for the mount read to settle. */
async function render(): Promise<ReturnType<typeof create>> {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(<AStudioPointsSection t={t as AStudioPointsSectionProps['t']} />)
  })
  await flush()
  await flush()
  return renderer!
}

function text(renderer: ReturnType<typeof create>): string {
  return JSON.stringify(renderer.toJSON())
}

/** The host node whose label is `label` — a button's accessible name here. */
function control(renderer: ReturnType<typeof create>, label: string): ReactTestInstance {
  const found = renderer.root.findAll(node => node.props['aria-label'] === label)
  expect(found.length, `no control labelled ${label}`).toBeGreaterThan(0)
  return found[0]!
}

/** Press a control and let both the request and the re-render settle. */
async function press(renderer: ReturnType<typeof create>, label: string): Promise<void> {
  act(() => { control(renderer, label).props.onClick() })
  await flush()
  await flush()
  await flush()
}

const BOTH_POOLS: AStudioWebPoints = {
  status: 'ok',
  general: { remaining: 1393, total: 2500 },
  spark: { remaining: 24621, total: 30000 },
}

/**
 * Route by path: the section reads the balance on mount, reads the status
 * document for the control key per press, then POSTs the claim.
 *
 * `controlKey: null` serves a status document with no key at all — a host that
 * hands out none, which is the one case where the press must not reach the route.
 */
function routedFetch(claim: unknown, balance: unknown = BOTH_POOLS, controlKey: string | null = 'k'.repeat(48)) {
  const calls: Array<{ url: string, init?: RequestInit | undefined }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === ASTRO_STATUS_PATH) {
      return mockResponse({
        auth: { state: 'signed-in' },
        catalog: { source: 'live', modelCount: 1, models: [{ id: 'spark-x2.5', name: 'Spark X2.5' }] },
        visibility: { hidden: [] },
        probe: { account: 'astudio-local', results: [] },
        ...(controlKey === null ? {} : { controlKey }),
      })
    }
    if (url === ASTRO_CLAIM_PATH) return mockResponse(claim)
    return mockResponse(balance)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('AStudioPointsSection', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('reads both pools when it opens, once, and never polls', async () => {
    const calls = routedFetch({ status: 'none' })
    const renderer = await render()

    const rendered = text(renderer)
    expect(rendered).toContain(en.generalPoints)
    expect(rendered).toContain('1393')
    expect(rendered).toContain(en.sparkPoints)
    expect(rendered).toContain('24621')
    // Opening the panel is the one unprompted read, and it asks for the current
    // number rather than a cached one: this page is a deliberate question.
    expect(calls.map(call => call.url)).toEqual([`${ASTRO_POINTS_PATH}?refresh=1`])
  })

  it('shows only the general pool when the account holds no Spark pool', async () => {
    routedFetch({ status: 'none' }, { status: 'ok', general: { remaining: 88 } })
    const renderer = await render()

    const rendered = text(renderer)
    expect(rendered).toContain('88')
    // An absent pool is absent, not a zero it never had.
    expect(rendered).not.toContain(en.sparkPoints)
  })

  it('re-reads the balance on refresh, bypassing the cache', async () => {
    const calls = routedFetch({ status: 'none' })
    const renderer = await render()

    await press(renderer, en.refreshPoints)

    expect(calls.map(call => call.url)).toEqual([
      `${ASTRO_POINTS_PATH}?refresh=1`,
      `${ASTRO_POINTS_PATH}?refresh=1`,
    ])
  })

  it('books the reward and shows the new balance without a second read', async () => {
    const calls = routedFetch({
      status: 'claimed',
      points: 100,
      balance: { status: 'ok', general: { remaining: 1493, total: 2500 }, spark: { remaining: 24721, total: 30000 } },
    })
    const renderer = await render()

    await press(renderer, en.claimPointsHint)

    const rendered = text(renderer)
    // The reward is visible as an increase, and the numbers come from the
    // claim's own answer rather than from a cached pre-claim read.
    expect(rendered).toContain('+100')
    expect(rendered).toContain('1493')
    expect(calls.map(call => call.url)).toEqual([
      `${ASTRO_POINTS_PATH}?refresh=1`,
      ASTRO_STATUS_PATH,
      ASTRO_CLAIM_PATH,
    ])
    expect(calls[2]!.init?.method).toBe('POST')
    expect((calls[2]!.init?.headers as Record<string, string>)[ASTRO_CONTROL_KEY_HEADER]).toBe('k'.repeat(48))
  })

  it('says so when today already held a reward, leaving the numbers alone', async () => {
    routedFetch({ status: 'none' })
    const renderer = await render()

    await press(renderer, en.claimPointsHint)

    const rendered = text(renderer)
    expect(rendered).toContain(en.claimNone)
    expect(rendered).toContain('1393')
    expect(rendered).not.toContain('+100')
  })

  it('refuses to claim when the host hands out no control key', async () => {
    const calls = routedFetch({ status: 'claimed', points: 100, balance: BOTH_POOLS }, BOTH_POOLS, null)
    const renderer = await render()

    await press(renderer, en.claimPointsHint)

    // No key, no write: the route would answer 403 anyway.
    expect(calls.some(call => call.url === ASTRO_CLAIM_PATH)).toBe(false)
    expect(text(renderer)).toContain(en.controlsUnavailable)
  })

  it('hides the numbers and says the sign-in expired when the session is dead', async () => {
    routedFetch({ status: 'expired' })
    const renderer = await render()
    expect(text(renderer)).toContain('1393')

    await press(renderer, en.claimPointsHint)

    const rendered = text(renderer)
    // A balance read before a dead session is not a balance any more.
    expect(rendered).not.toContain('1393')
    expect(rendered).toContain(en.pointsExpired)
  })

  it('reports a failed press instead of pretending it worked', async () => {
    routedFetch({ status: 'unavailable' })
    const renderer = await render()

    await press(renderer, en.claimPointsHint)

    const rendered = text(renderer)
    expect(rendered).toContain(en.pointsUnavailable)
    expect(rendered).not.toContain('+100')
  })

  it('explains an unreadable balance and still offers a retry', async () => {
    routedFetch({ status: 'none' }, { status: 'unavailable' })
    const renderer = await render()

    const rendered = text(renderer)
    expect(rendered).toContain(en.pointsRetryHint)
    // No number is invented for a read that did not happen.
    expect(rendered).toContain('—')
    expect(control(renderer, en.refreshPoints).props.disabled).toBe(false)
  })

  it('tells a never-signed-in account where the balance comes from, holding the claim', async () => {
    const calls = routedFetch({ status: 'none' }, { status: 'signed-out' })
    const renderer = await render()

    expect(text(renderer)).toContain(en.pointsSignedOut)
    // There is no session to book a reward against, so the press is not offered
    // as a live action — a disabled button whose press can only fail is a lie.
    expect(control(renderer, en.claimPointsHint).props.disabled).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('still lets a press answer when only the balance read failed', async () => {
    // `unavailable` says nothing about the session behind it: the claim route
    // gets to answer with its own verdict rather than being pre-empted.
    routedFetch({ status: 'none' }, { status: 'unavailable' })
    const renderer = await render()

    expect(control(renderer, en.claimPointsHint).props.disabled).toBe(false)
  })

  it('answers a press in place, without hiding the numbers while it runs', async () => {
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === ASTRO_STATUS_PATH) {
        return mockResponse({ auth: { state: 'signed-in' }, catalog: { source: 'empty', modelCount: 0, models: [] }, visibility: { hidden: [] }, probe: { account: '', results: [] }, controlKey: 'k'.repeat(48) })
      }
      if (url === ASTRO_CLAIM_PATH) {
        await new Promise<void>(resolve => { release = resolve })
        return mockResponse({ status: 'claimed', points: 100, balance: BOTH_POOLS })
      }
      return mockResponse(BOTH_POOLS)
    }))
    const renderer = await render()

    act(() => { control(renderer, en.claimPointsHint).props.onClick() })
    await flush()

    const busy = control(renderer, en.claimPointsHint)
    expect(busy.props.disabled).toBe(true)
    expect(busy.props['aria-busy']).toBe(true)
    expect(busy.props.children).toBe(en.claiming)
    // The numbers stay readable while the request is in flight.
    expect(text(renderer)).toContain('1393')

    await act(async () => { release?.() })
    await flush()
    await flush()

    expect(text(renderer)).toContain('+100')
  })
})

describe('points-client documents', () => {
  it('accepts the route documents it serves', () => {
    expect(isPointsDocument({ status: 'ok', general: { remaining: 1 } })).toBe(true)
    expect(isClaimDocument({ status: 'claimed', balance: { status: 'ok', general: { remaining: 1 } } })).toBe(true)
  })

  it('rejects anything else, including an unknown status', () => {
    expect(isPointsDocument({ status: 'weird' })).toBe(false)
    expect(isPointsDocument(null)).toBe(false)
    expect(isClaimDocument({ status: 'weird' })).toBe(false)
    expect(isClaimDocument([])).toBe(false)
  })
})
