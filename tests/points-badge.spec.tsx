import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create, act } from 'react-test-renderer'
import { AStudioPointsBadge } from '../src/client/AStudioPointsBadge.tsx'
import type { AStudioPointsBadgeProps } from '../src/client/AStudioPointsBadge.tsx'
import { ASTRO_POINTS_PATH } from '../src/status-paths.ts'
import type { AStudioWebPoints } from '../src/status-paths.ts'
import { en } from '../src/client/locales.ts'

/**
 * The composer badge: AStudio's two credit pools beside the model selector,
 * shown only while this session has an AStudio model selected.
 */

const t = (key: string): string => en[key as keyof typeof en] ?? key

/** Build a fetch Response stand-in. */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

/** Flush pending promises inside act. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/**
 * A stand-in for the host's snapshot store: the badge subscribes, and a
 * `set` below notifies like the host does once the session projection lands.
 */
function directoryStore(initial: { current: { provider: string, model: string } | null } | { current: undefined }) {
  const listeners = new Set<() => void>()
  let snapshot = initial
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot(): typeof snapshot {
      return snapshot
    },
    set(next: typeof snapshot): void {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function render(props: AStudioPointsBadgeProps): ReturnType<typeof create> {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(<AStudioPointsBadge {...props} />)
  })
  return renderer!
}

function text(renderer: ReturnType<typeof create>): string {
  return JSON.stringify(renderer.toJSON())
}

const BOTH_POOLS: AStudioWebPoints = {
  status: 'ok',
  general: { remaining: 1393, total: 2500 },
  spark: { remaining: 24621, total: 30000 },
}

describe('AStudioPointsBadge visibility', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('renders nothing when another provider is selected, and asks nothing of the host', () => {
    const fetchMock = vi.fn(async () => mockResponse(BOTH_POOLS))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: { provider: 'openai', model: 'gpt' } })
    const renderer = render({ directory: store as never, t })
    expect(renderer.toJSON()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders nothing while the selection is not ready, but keeps subscribing', async () => {
    const fetchMock = vi.fn(async () => mockResponse(BOTH_POOLS))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: null })
    const renderer = render({ directory: store as never, t })
    expect(renderer.toJSON()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    // The host's projection lands: the seat appears without a remount.
    act(() => { store.set({ current: { provider: 'astudio', model: 'spark-x2.5' } }) })
    await flush()
    await flush()
    expect(fetchMock).toHaveBeenCalled()
    expect(text(renderer)).toContain('1393')
  })

  it('renders nothing when the provider switches away mid-session', async () => {
    const fetchMock = vi.fn(async () => mockResponse(BOTH_POOLS))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    expect(text(renderer)).toContain('1393')

    act(() => { store.set({ current: { provider: 'openai', model: 'gpt' } }) })
    await flush()
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('AStudioPointsBadge rendering', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('shows both pools side by side without adding them together', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(BOTH_POOLS)))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()

    const rendered = text(renderer)
    expect(rendered).toContain('1393')
    expect(rendered).toContain('24621')
    // The pools pay for different things; a combined total would be a lie.
    expect(rendered).not.toContain('26014')
  })

  it('renders a zero balance as a real number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({
      status: 'ok',
      general: { remaining: 0, total: 2500 },
      spark: { remaining: 0, total: 30000 },
    } satisfies AStudioWebPoints)))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    expect(text(renderer)).toContain('0')
  })

  it('shows only the general pool when the account has no Spark pool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({
      status: 'ok',
      general: { remaining: 1393, total: 2500 },
    } satisfies AStudioWebPoints)))
    const store = directoryStore({ current: { provider: 'astudio', model: 'xopglm52' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    const rendered = text(renderer)
    expect(rendered).toContain('1393')
    expect(rendered).not.toContain('24621')
    expect(rendered).not.toContain('NaN')
  })

  it('hides the numbers, keeping the refresh control, when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 'unavailable' })))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    const rendered = text(renderer)
    expect(rendered).not.toContain('1393')
    expect(rendered).not.toContain('NaN')
    // The ↻ stays available: a failed read must be retryable in place.
    expect(renderer.root.findAll(node => node.props['aria-label'] === en.refreshPoints).length).toBeGreaterThan(0)
  })

  it('shows nothing numeric when the session expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 'expired' })))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    expect(text(renderer)).not.toContain('NaN')
  })

  it('renders nothing when AStudio was never signed in here', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 'signed-out' })))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    // Signed out means no account to report a balance for: no seat at all.
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('AStudioPointsBadge refresh', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('reads once on mount', async () => {
    const fetchMock = vi.fn(async (_url: string) => mockResponse(BOTH_POOLS))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    render({ directory: store as never, t })
    await flush()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ASTRO_POINTS_PATH)
  })

  it('does not poll on a timer', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => mockResponse(BOTH_POOLS))
      vi.stubGlobal('fetch', fetchMock)
      const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
      render({ directory: store as never, t })
      await act(async () => { await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(10 * 60_000) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks upstream for a fresh read when ↻ is clicked', async () => {
    const fetchMock = vi.fn(async (_url: string) => mockResponse(BOTH_POOLS))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()

    const refresh = renderer.root.findAll(node => node.props['aria-label'] === en.refreshPoints)
    act(() => { refresh[0]!.props.onClick() })
    await flush()
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${ASTRO_POINTS_PATH}?refresh=1`)
  })

  it('replaces the numbers with the newly read balance', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse(BOTH_POOLS))
      .mockResolvedValueOnce(mockResponse({
        status: 'ok',
        general: { remaining: 1300, total: 2500 },
        spark: { remaining: 24000, total: 30000 },
      } satisfies AStudioWebPoints))
    vi.stubGlobal('fetch', fetchMock)
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    expect(text(renderer)).toContain('1393')

    const refresh = renderer.root.findAll(node => node.props['aria-label'] === en.refreshPoints)
    act(() => { refresh[0]!.props.onClick() })
    await flush()
    await flush()

    const rendered = text(renderer)
    expect(rendered).toContain('1300')
    expect(rendered).not.toContain('1393')
  })

  it('never renders a credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(BOTH_POOLS)))
    const store = directoryStore({ current: { provider: 'astudio', model: 'spark-x2.5' } })
    const renderer = render({ directory: store as never, t })
    await flush()
    await flush()
    expect(text(renderer)).not.toContain('sso')
  })
})
