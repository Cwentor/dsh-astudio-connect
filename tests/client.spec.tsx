import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create, act } from 'react-test-renderer'
import { apply, BUNDLE_NAME, desensitizeToken } from '../src/client/index.tsx'
import { isAStudioWebStatus } from '../src/client/status-document.ts'
import { en } from '../src/client/locales.ts'
import { AStudioConfigPage } from '../src/client/AStudioConfigPage.tsx'
import { AStudioPluginCard } from '../src/client/AStudioPluginCard.tsx'

/** A translate function that returns the English dictionary value, falling back to the key. */
const t = (key: string): string => en[key as keyof typeof en] ?? key

/** Build a minimal fetch Response stand-in. */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Flush pending microtasks/promises inside a react-test-renderer act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** A status document with the required sections. */
function statusDoc(overrides: Partial<{
  auth: { state: 'signed-in' | 'signed-out' }
  catalog: { source: 'live' | 'saved' | 'empty', modelCount: number, models: Array<{ id: string, name: string }>, failure?: string }
  probeKey: string
}> = {}): unknown {
  return {
    auth: overrides.auth ?? { state: 'signed-out' },
    catalog: overrides.catalog ?? { source: 'empty', modelCount: 0, models: [] },
    visibility: { hidden: [] },
    probe: { account: '', results: [] },
    ...(overrides.probeKey !== undefined ? { probeKey: overrides.probeKey } : {}),
  }
}

describe('desensitizeToken', () => {
  it('shows dash for undefined', () => {
    expect(desensitizeToken(undefined)).toBe('—')
  })

  it('shows full token when short', () => {
    expect(desensitizeToken('abc')).toBe('abc… (len=3)')
  })

  it('shows prefix and length for long tokens', () => {
    const token = '16c814c_test_token_for_unit_tests'
    const result = desensitizeToken(token)
    expect(result.startsWith('16c814c…')).toBe(true)
    expect(result).toContain(`len=${token.length}`)
  })

  it('does not contain the full token', () => {
    const token = '16c814c_test_token_for_unit_tests'
    const result = desensitizeToken(token)
    expect(result.includes(token)).toBe(false)
  })
})

describe('isAStudioWebStatus', () => {
  it('accepts a well-formed status document', () => {
    expect(isAStudioWebStatus(statusDoc())).toBe(true)
  })

  it('accepts a signed-in document', () => {
    expect(isAStudioWebStatus(statusDoc({ auth: { state: 'signed-in' } }))).toBe(true)
  })

  it('rejects a non-object', () => {
    expect(isAStudioWebStatus(null)).toBe(false)
    expect(isAStudioWebStatus(42)).toBe(false)
  })

  it('rejects a document with an unknown sign-in state', () => {
    expect(isAStudioWebStatus(statusDoc({ auth: { state: 'weird' } as never }))).toBe(false)
  })
})

describe('apply', () => {
  /**
   * A stand-in for the host client context: the locale face, the slot registry,
   * and the model-directories service the composer badge resolves its session's
   * selection through.
   */
  function clientContext(registered: string[]): unknown {
    const slots = {
      inject: (key: string, cb: () => () => void): void => {
        registered.push(`inject:${key}`)
        const disposer = cb()
        void disposer
      },
      register: (opts: { name: string }, component: unknown): () => void => {
        registered.push(`register:${opts.name}`)
        void component
        return () => {}
      },
    }
    return {
      effect: (fn: () => () => void): () => void => { const d = fn(); return d },
      locale: {
        register: (namespace: string): void => { registered.push(`locale:${namespace}`) },
        bind: (namespace: string): (key: string) => string => (key: string): string => `${namespace}:${key}`,
      },
      slots,
      // `ctx.inject(['modelDirectories'], …)` runs the callback once the service
      // is present; the fake provides it immediately.
      inject: (deps: string[], cb: (scope: unknown) => void): void => {
        for (const dep of deps) registered.push(`service:${dep}`)
        cb({ slots, modelDirectories: { directoryFor: () => ({ store: {} }) } })
      },
    }
  }

  it('registers the locale namespace and both slots it contributes to', () => {
    const registered: string[] = []
    apply(clientContext(registered) as never)

    expect(registered).toContain('locale:settings.astudio')
    expect(registered).toContain('inject:plugins.bundle.config')
    expect(registered).toContain('register:plugins.bundle.config')
    // The composer badge: beside the model selector, gated on the session's
    // selected provider.
    expect(registered).toContain('service:modelDirectories')
    expect(registered).toContain('inject:conversation.input.right')
    expect(registered).toContain('register:conversation.input.right')
  })

  it('no longer contributes to the DSH 0.1.5 settings tab seat', () => {
    // 0.1.5 support was dropped: `settings.plugin.item` is declared by no
    // shipped package any more, so registering it was dead code kept alive only
    // by a local SlotMap mirror. A 0.2.x host must see exactly one settings
    // surface from this bundle.
    const registered: string[] = []
    apply(clientContext(registered) as never)

    expect(registered).not.toContain('inject:settings.plugin.item')
    expect(registered).not.toContain('register:settings.plugin.item')
  })

  it('exports the bundle name used as the config-page key', () => {
    expect(BUNDLE_NAME).toBe('dsh-astudio-connect')
  })
})

describe('AStudioConfigPage', () => {
  it('renders the card inside a list', () => {
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioConfigPage view="page" t={t} />)
    })
    const json = JSON.stringify(renderer!.toJSON())
    expect(json).toContain('AStudio Connect')
  })
})

describe('AStudioPluginCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches the status document and renders the sign-in state after expanding', async () => {
    const fetchMock = vi.fn(async () => mockResponse(statusDoc({ auth: { state: 'signed-in' } })))
    vi.stubGlobal('fetch', fetchMock)

    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioPluginCard t={t} />)
    })
    // Expand the card so the fetch effect runs.
    const header = renderer!.root.findAllByProps({ 'aria-expanded': false })
    act(() => { header[0]!.props.onClick() })
    await flush()
    await flush()

    const json = JSON.stringify(renderer!.toJSON())
    expect(json).toContain('Signed in')
    expect(fetchMock).toHaveBeenCalledWith('/astudio/status', expect.anything())
  })

  it('renders the built-in catalog source when signed out', async () => {
    const fetchMock = vi.fn(async () => mockResponse(statusDoc({ auth: { state: 'signed-out' } })))
    vi.stubGlobal('fetch', fetchMock)

    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioPluginCard t={t} />)
    })
    const header = renderer!.root.findAllByProps({ 'aria-expanded': false })
    act(() => { header[0]!.props.onClick() })
    await flush()
    await flush()

    const json = JSON.stringify(renderer!.toJSON())
    expect(json).toContain('Not signed in')
    // A signed-out card shows no model section at all, and never names a
    // catalog "source" in place of one.
    expect(json).not.toContain('No models available')
  })

  it('says no models are available instead of listing a placeholder', async () => {
    const fetchMock = vi.fn(async () => mockResponse(statusDoc({
      auth: { state: 'signed-in' },
      catalog: { source: 'empty', modelCount: 0, models: [], failure: 'empty-roster' },
    })))
    vi.stubGlobal('fetch', fetchMock)

    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioPluginCard t={t} />)
    })
    const header = renderer!.root.findAllByProps({ 'aria-expanded': false })
    act(() => { header[0]!.props.onClick() })
    await flush()
    await flush()

    const json = JSON.stringify(renderer!.toJSON())
    expect(json).toContain('No models available')
    expect(json).toContain(en.catalogFailureRoster)
  })

  it('probes with the probe key header', async () => {
    const fetchMock = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      if (url === '/astudio/status') {
        return mockResponse(statusDoc({
          auth: { state: 'signed-in' },
          probeKey: 'test-probe-key',
          catalog: { source: 'live', modelCount: 1, models: [{ id: 'spark-x2.5', name: 'Spark X2.5' }] },
        }))
      }
      if (url === '/astudio/probe/spark-x2.5') {
        return mockResponse({ state: 'ok', efforts: ['low'] })
      }
      return mockResponse({ error: 'unknown' }, false, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioPluginCard t={t} />)
    })
    const header = renderer!.root.findAllByProps({ 'aria-expanded': false })
    act(() => { header[0]!.props.onClick() })
    await flush()
    await flush()

    // Find a probe button and click it.
    const buttons = renderer!.root.findAllByType('button')
    const probeButton = buttons.find(b => b.props.children === 'Probe')
    act(() => { probeButton!.props.onClick() })
    await flush()
    await flush()

    const probeCall = fetchMock.mock.calls.find(call => call[0] === '/astudio/probe/spark-x2.5')
    expect(probeCall).toBeDefined()
    const init = probeCall![1] as { headers: Record<string, string> }
    expect(init.headers['x-astudio-probe-key']).toBe('test-probe-key')
  })
})
