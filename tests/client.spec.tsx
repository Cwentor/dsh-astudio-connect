import { describe, it, expect } from 'vitest'
import { create, act } from 'react-test-renderer'
import AStudioSettingsPage, { desensitizeToken } from '../src/client/index.tsx'
import { createAStudioAuth } from '../src/auth.ts'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

function renderPage(
  store: ReturnType<typeof createAStudioAuth>,
  catalog: ReturnType<typeof createAStudioCatalog>,
) {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(
      <AStudioSettingsPage store={store} catalog={catalog} />,
    )
  })
  const json = renderer!.toJSON()
  return JSON.stringify(json)
}

function testCatalog(store: ReturnType<typeof createAStudioAuth>) {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => store.resolve(),
  })
}

describe('AStudioSettingsPage', () => {
  it('renders connected sign-in state and catalog source', () => {
    const testFile = join(tmpdir(), `astudio-client-test-${Date.now()}.toml`)
    writeFileSync(testFile, `experimental_bearer_token = "16c814c_test_token"`, 'utf8')

    const store = createAStudioAuth({ configPath: testFile })
    const html = renderPage(store, testCatalog(store))

    expect(html).toContain('Connected')
    expect(html).toContain('Catalog source')
    expect(html).toContain('Token expiry')

    if (existsSync(testFile)) unlinkSync(testFile)
  })

  it('renders not-connected sign-in state', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const html = renderPage(store, testCatalog(store))

    expect(html).toContain('Not connected')
  })

  it('renders the context window and image capability per model', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const html = renderPage(store, testCatalog(store))

    for (const model of DEFAULT_CATALOG) {
      expect(html).toContain(model.name)
      expect(html).toContain(String(model.contextWindow))
      expect(html).toContain(model.supportsImages === true ? 'supported' : 'not supported')
    }
  })

  it('renders the rate placeholder and probe summary', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const html = renderPage(store, testCatalog(store))

    expect(html).toContain('Rate')
    expect(html).toContain('Unknown')
  })

  it('renders refresh and probe controls', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const html = renderPage(store, testCatalog(store))

    expect(html).toContain('Refresh catalog')
    expect(html).toContain('Probe')
  })
})
