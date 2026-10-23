import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, act } from 'react-test-renderer'
import type { ReactTestInstance } from 'react-test-renderer'
import { apply, BUNDLE_NAME, desensitizeToken } from '../src/client/index.tsx'
import { isAStudioWebStatus } from '../src/client/status-document.ts'
import { en } from '../src/client/locales.ts'
import { AStudioConfigPage } from '../src/client/AStudioConfigPage.tsx'
import { AStudioPluginCard } from '../src/client/AStudioPluginCard.tsx'

/**
 * A translate function that returns the English dictionary value, falling back
 * to the key. Interpolates `{name}` params the way the host's `t` does, so
 * assertions can read the rendered sentence rather than its template.
 */
const t = (key: string, params?: Record<string, unknown>): string => {
  const raw = en[key as keyof typeof en] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder)
}

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
  controlKey: string
  hidden: string[]
}> = {}): unknown {
  return {
    auth: overrides.auth ?? { state: 'signed-out' },
    catalog: overrides.catalog ?? { source: 'empty', modelCount: 0, models: [] },
    visibility: { hidden: overrides.hidden ?? [] },
    probe: { account: '', results: [] },
    ...(overrides.controlKey !== undefined ? { controlKey: overrides.controlKey } : {}),
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

  afterEach(() => {
    // The press test stubs `navigator` to prove the haptic tick is asked for;
    // leaving that in place would hide the no-op path every other test takes.
    vi.unstubAllGlobals()
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
          controlKey: 'test-control-key',
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
    expect(init.headers['x-astudio-control-key']).toBe('test-control-key')
  })

  it('renders one switch per model, off for the hidden ones', async () => {
    const fetchMock = vi.fn(async () => mockResponse(statusDoc({
      auth: { state: 'signed-in' },
      controlKey: 'test-control-key',
      hidden: ['spark-x2.5'],
      catalog: {
        source: 'live',
        modelCount: 2,
        models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'spark-x2.5', name: 'Spark-X2.5' }],
      },
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

    const switches = renderer!.root.findAllByType('input')
    expect(switches.map(box => box.props.checked)).toEqual([true, false])
    // The section is called "Models" and reports the exposed count, not the
    // roster size: hiding a model has to be visible as a number.
    const json = JSON.stringify(renderer!.toJSON())
    expect(json).toContain(en.modelHeading)
    expect(json).toContain('Exposing 1 of 2 to DSH')
    expect(json).not.toContain(en.modelNoneExposed)
  })

  /** Two models to toggle against. */
  const ROSTER = [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'spark-x2.5', name: 'Spark-X2.5' }]

  /**
   * A fetch stand-in that behaves like the host: a visibility write sticks, so
   * the status read that follows it reports what the write actually did.
   */
  function host(options: {
    models?: Array<{ id: string, name: string }>
    hidden?: string[]
    failWritesFor?: string[]
  } = {}) {
    const models = options.models ?? ROSTER
    const state = {
      hidden: new Set(options.hidden ?? []),
      calls: [] as Array<{ url: string, init: { method?: string, headers?: Record<string, string>, body?: string } }>,
    }
    const fetchMock = vi.fn(async (
      url: string,
      init: { method?: string, headers?: Record<string, string>, body?: string } = {},
    ) => {
      state.calls.push({ url, init })
      if (url === '/astudio/status') {
        return mockResponse(statusDoc({
          auth: { state: 'signed-in' },
          controlKey: 'test-control-key',
          hidden: [...state.hidden],
          catalog: { source: 'live', modelCount: models.length, models },
        }))
      }
      const prefix = '/astudio/visibility/'
      if (url.startsWith(prefix)) {
        const id = decodeURIComponent(url.slice(prefix.length))
        if ((options.failWritesFor ?? []).includes(id)) return mockResponse({ error: 'write-failed' }, false, 500)
        const body = JSON.parse(init.body ?? 'null') as { visible?: boolean }
        if (body.visible === true) state.hidden.delete(id)
        else state.hidden.add(id)
        return mockResponse({ modelId: id, visible: body.visible })
      }
      return mockResponse({ error: 'unknown' }, false, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { state, fetchMock }
  }

  /** Render the card, expand it, and wait for its first status read. */
  async function openCard(): Promise<ReturnType<typeof create>> {
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(<AStudioPluginCard t={t} />)
    })
    const header = renderer!.root.findAllByProps({ 'aria-expanded': false })
    act(() => { header[0]!.props.onClick() })
    await flush()
    await flush()
    return renderer!
  }

  /** The host node whose label is `label`; an in-flight button shows another. */
  function button(renderer: ReturnType<typeof create>, label: string): ReactTestInstance {
    const found = renderer.root.findAllByType('button').find(node => node.props.children === label)
    expect(found, `no button labelled ${label}`).toBeDefined()
    return found as ReactTestInstance
  }

  function switchAt(renderer: ReturnType<typeof create>, index: number): ReactTestInstance {
    const box = renderer.root.findAllByType('input')[index]
    expect(box, `no switch at ${index}`).toBeDefined()
    return box as ReactTestInstance
  }

  function writes(state: { calls: Array<{ url: string }> }): string[] {
    return state.calls.filter(call => call.url.startsWith('/astudio/visibility/')).map(call => call.url)
  }

  it('records a switch as a draft and writes nothing before Save', async () => {
    const server = host()
    const renderer = await openCard()

    act(() => { switchAt(renderer, 0).props.onChange({}) })
    await flush()

    // The click is local: the roster DSH sees has not changed yet.
    expect(writes(server.state)).toEqual([])
    expect(switchAt(renderer, 0).props.checked).toBe(false)
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('1 unsaved change(s)')
    // The count is phrased as a consequence of saving, not as a fact about DSH.
    expect(json).toContain('Once saved, 1 of 2 exposed to DSH')
    expect(json).not.toContain('Exposing 1 of 2 to DSH')
  })

  it('writes every drafted model on Save, then re-reads and clears the draft', async () => {
    const server = host()
    const renderer = await openCard()

    act(() => { switchAt(renderer, 0).props.onChange({}) })
    act(() => { switchAt(renderer, 1).props.onChange({}) })
    await flush()
    expect(JSON.stringify(renderer.toJSON())).toContain('2 unsaved change(s)')

    await act(async () => { button(renderer, en.modelSave).props.onClick() })
    await flush()
    await flush()

    // One write per changed model, sequential, both authorized and both off.
    expect(writes(server.state)).toEqual([
      '/astudio/visibility/glm-5.2',
      '/astudio/visibility/spark-x2.5',
    ])
    const sent = server.state.calls.filter(call => call.url.startsWith('/astudio/visibility/'))
    expect(sent.every(call => call.init.method === 'POST')).toBe(true)
    expect(sent.every(call => call.init.headers?.['x-astudio-control-key'] === 'test-control-key')).toBe(true)
    expect(sent.map(call => JSON.parse(call.init.body ?? 'null'))).toEqual([{ visible: false }, { visible: false }])
    // A write is followed by a read: the host, not the click, is the authority.
    expect(server.state.calls.filter(call => call.url === '/astudio/status').length).toBeGreaterThanOrEqual(2)

    const json = JSON.stringify(renderer.toJSON())
    expect(json).not.toContain('unsaved')
    expect(json).toContain(en.modelSaved)
    expect(switchAt(renderer, 0).props.checked).toBe(false)
  })

  it('keeps a row the host refused in the draft and says how many failed', async () => {
    const server = host({ failWritesFor: ['spark-x2.5'] })
    const renderer = await openCard()

    act(() => { switchAt(renderer, 0).props.onChange({}) })
    act(() => { switchAt(renderer, 1).props.onChange({}) })
    await act(async () => { button(renderer, en.modelSave).props.onClick() })
    await flush()
    await flush()

    expect(writes(server.state)).toHaveLength(2)
    // The accepted row is gone from the draft; the refused one is still pending,
    // because a switch that silently agrees with a host that never accepted the
    // write is worse than one that admits it did not save.
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('1 change(s) could not be saved')
    // The header badge still carries the pending count, so the refused row is
    // visible even while the hint line is busy reporting the failure.
    expect(json).toContain('1 unsaved')
    // And the exposure line goes back to describing DSH, not the draft: the
    // refused model is still offered, so a "once saved" count would overstate.
    expect(json).toContain('Exposing 1 of 2 to DSH')
    expect(json).not.toContain('Once saved')
  })

  it('drops the draft on Discard without writing', async () => {
    const server = host()
    const renderer = await openCard()

    act(() => { switchAt(renderer, 0).props.onChange({}) })
    await flush()
    act(() => { button(renderer, en.modelDiscard).props.onClick() })
    await flush()

    expect(writes(server.state)).toEqual([])
    expect(switchAt(renderer, 0).props.checked).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain(en.modelCleanHint)
  })

  it('dips the probe button under the pointer and fires a haptic tick', async () => {
    const vibrate = vi.fn(() => true)
    vi.stubGlobal('navigator', { vibrate })
    const server = host()
    const renderer = await openCard()

    act(() => { button(renderer, en.probeStart).props.onPointerDown({ pointerType: 'mouse' }) })

    // Depth: the button moves towards the page and the shadow moves inside it.
    const pressed = button(renderer, en.probeStart).props.style as unknown as Record<string, string>
    expect(pressed.transform).toBe('translateY(1px) scale(0.965)')
    expect(pressed.boxShadow).toContain('inset')
    expect(vibrate).toHaveBeenCalledWith(8)
    // Pressing is not doing: no request has left the browser yet.
    expect(server.state.calls.some(call => call.url.startsWith('/astudio/probe/'))).toBe(false)

    act(() => { button(renderer, en.probeStart).props.onPointerUp() })
    const released = button(renderer, en.probeStart).props.style as unknown as Record<string, string>
    expect(released.transform).toBeUndefined()
  })

  it('answers a press immediately with a running label, and holds the other rows', async () => {
    let releaseProbe: (() => void) | undefined
    const models = [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'spark-x2.5', name: 'Spark-X2.5' }]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/astudio/status') {
        return mockResponse(statusDoc({
          auth: { state: 'signed-in' },
          controlKey: 'test-control-key',
          catalog: { source: 'live', modelCount: models.length, models },
        }))
      }
      if (url === '/astudio/probe/glm-5.2') {
        await new Promise<void>(resolve => { releaseProbe = resolve })
        return mockResponse({ state: 'ok', efforts: ['low'] })
      }
      return mockResponse({ error: 'unknown' }, false, 404)
    }))
    const renderer = await openCard()

    await act(async () => { button(renderer, en.probeStart).props.onClick() })
    await flush()

    const running = button(renderer, en.probeRunning)
    expect(running.props.disabled).toBe(true)
    expect(running.props['aria-busy']).toBe(true)
    // The second model waits rather than spending a parallel upstream request.
    const waiting = button(renderer, en.probeStart)
    expect(waiting.props.disabled).toBe(true)

    await act(async () => { releaseProbe?.() })
    await flush()
    await flush()

    // The verdict is announced off the refreshed document, not assumed.
    expect(JSON.stringify(renderer.toJSON())).toContain('GLM-5.2 · Not probed')
  })

  it('warns when every model is hidden', async () => {
    const fetchMock = vi.fn(async () => mockResponse(statusDoc({
      auth: { state: 'signed-in' },
      controlKey: 'test-control-key',
      hidden: ['spark-x2.5'],
      catalog: { source: 'live', modelCount: 1, models: [{ id: 'spark-x2.5', name: 'Spark-X2.5' }] },
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
    expect(json).toContain(en.modelNoneExposed)
  })
})
